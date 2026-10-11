import {
  getLlama,
  LlamaChatSession,
  resolveChatWrapper,
  type ChatHistoryItem,
  type ChatWrapper,
  type Llama,
  type LlamaContext,
  type LlamaModel,
} from "node-llama-cpp";
import type { ChatMessage } from "../../shared/electron-api";

export interface LlmLoadOptions {
  modelPath: string;
  contextSize?: number;
  /** null/undefined = deixar o node-llama-cpp decidir. */
  threads?: number | null;
  /** Abortar interrompe o carregamento (troca concorrente: a última vence). */
  signal?: AbortSignal;
}

export interface LlmGenerateOptions {
  /** Histórico completo; a última mensagem deve ser do usuário. */
  messages: ChatMessage[];
  onTextChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LlmGenerateResult {
  text: string;
  /** true quando a geração foi interrompida (pelo chamador ou por troca/descarga do modelo). */
  canceled: boolean;
}

export interface LlmRuntimeInfo {
  backend: string;
  modelPath: string;
  contextSize: number;
}

const DEFAULT_CONTEXT_SIZE = 4096;

/** Histórico neutro → formato do node-llama-cpp (o chat template do modelo é aplicado por ele). */
function toChatHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  return messages.map((m): ChatHistoryItem => {
    if (m.role === "system") return { type: "system", text: m.content };
    if (m.role === "user") return { type: "user", text: m.content };
    return { type: "model", response: [m.content] };
  });
}

/**
 * Runtime de LLM local (node-llama-cpp). Não depende do Electron. Mantém no máximo um modelo
 * carregado: carregar outro descarrega o atual antes (nunca dois modelos na RAM).
 */
export class LlmRuntime {
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  /** Chat wrapper do modelo carregado: o mesmo na geração e na contagem de tokens do prompt. */
  private chatWrapper: ChatWrapper | null = null;
  private loading: Promise<void> | null = null;
  private modelPath: string | null = null;
  // Serializa gerações: um contexto tem uma única sequência de inferência.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly generations = new Set<AbortController>();
  // Geração executando agora (não as que aguardam na fila): é só ela que a troca de modelo espera.
  private activeRun: Promise<unknown> | null = null;

  get isLoaded(): boolean {
    return this.model !== null && this.context !== null;
  }

  get loadedPath(): string | null {
    return this.isLoaded ? this.modelPath : null;
  }

  get info(): LlmRuntimeInfo | null {
    if (!this.llama || !this.context || !this.modelPath) return null;
    return {
      backend: this.llama.gpu === false ? "cpu" : this.llama.gpu,
      modelPath: this.modelPath,
      contextSize: this.context.contextSize,
    };
  }

  /** Carrega o modelo (idempotente para o mesmo path). Interrompe gerações do modelo anterior. */
  async load(options: LlmLoadOptions): Promise<void> {
    await this.loading?.catch(() => undefined);
    options.signal?.throwIfAborted();
    if (this.isLoaded && this.modelPath === options.modelPath) return;

    this.loading = this.doLoad(options).finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  /** Descarrega o modelo atual (interrompe gerações em andamento). */
  async unload(): Promise<void> {
    await this.loading?.catch(() => undefined);
    await this.stopGenerations();
    await this.unloadModel();
  }

  private async doLoad({ modelPath, contextSize, threads, signal }: LlmLoadOptions): Promise<void> {
    await this.stopGenerations();
    await this.unloadModel();
    this.llama ??= await getLlama();
    signal?.throwIfAborted();
    const model = await this.llama.loadModel({ modelPath, loadSignal: signal });
    try {
      signal?.throwIfAborted();
      this.context = await model.createContext({
        contextSize: contextSize ?? DEFAULT_CONTEXT_SIZE,
        createSignal: signal,
        ...(threads ? { threads } : {}),
      });
    } catch (error) {
      await model.dispose();
      throw error;
    }
    this.model = model;
    this.modelPath = modelPath;
    this.chatWrapper = resolveChatWrapper(model);
  }

  /**
   * Tokens que `messages` ocupam no contexto, com o chat template do modelo aplicado e o início da
   * resposta já aberto: exatamente o que a geração avalia antes do primeiro token. Aguarda um
   * carregamento em andamento.
   */
  async countPromptTokens(messages: ChatMessage[]): Promise<number> {
    await this.loading?.catch(() => undefined);
    if (!this.model || !this.chatWrapper) throw new Error("Nenhum modelo carregado. Escolha um modelo no topo da tela.");
    const { contextText } = this.chatWrapper.generateContextState({
      chatHistory: [...toChatHistory(messages), { type: "model", response: [] }],
    });
    return contextText.tokenize(this.model.tokenizer).length;
  }

  /** Tokens de um texto solto no tokenizer do modelo carregado (ex.: tamanho da resposta). */
  async countTextTokens(text: string): Promise<number> {
    await this.loading?.catch(() => undefined);
    if (!this.model) throw new Error("Nenhum modelo carregado. Escolha um modelo no topo da tela.");
    return this.model.tokenize(text).length;
  }

  /** Tamanho do contexto do modelo carregado (aguarda um carregamento em andamento). */
  async contextSize(): Promise<number> {
    await this.loading?.catch(() => undefined);
    if (!this.context) throw new Error("Nenhum modelo carregado. Escolha um modelo no topo da tela.");
    return this.context.contextSize;
  }

  /** Gera texto em streaming. Aguarda um carregamento em andamento antes de começar. */
  generate(options: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const run = this.queue.then(() => this.doGenerate(options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doGenerate(options: LlmGenerateOptions): Promise<LlmGenerateResult> {
    await this.loading?.catch(() => undefined);
    const run = this.runPrompt(options);
    this.activeRun = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  private async runPrompt({ messages, onTextChunk, signal }: LlmGenerateOptions): Promise<LlmGenerateResult> {
    if (!this.context) throw new Error("Nenhum modelo carregado. Escolha um modelo no topo da tela.");
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") throw new Error("A última mensagem precisa ser do usuário.");

    // Abortar pelo chamador OU por troca/descarga do modelo.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.generations.add(controller);

    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      autoDisposeSequence: true,
      ...(this.chatWrapper ? { chatWrapper: this.chatWrapper } : {}),
    });
    try {
      session.setChatHistory(toChatHistory(messages.slice(0, -1)));
      const text = await session.prompt(last.content, {
        onTextChunk,
        signal: controller.signal,
        stopOnAbortSignal: true,
      });
      const canceled = controller.signal.aborted;
      // Evidência do cancelamento real: a inferência parou aqui, não só a UI.
      if (canceled) console.info(`[llm] geração abortada após ${text.length} caracteres`);
      return { text, canceled };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.generations.delete(controller);
      session.dispose();
    }
  }

  /** Libera sessão, contexto, modelo e a instância do llama.cpp (fechamento do app). */
  async dispose(): Promise<void> {
    await this.unload();
    if (this.llama) {
      await this.llama.dispose();
      this.llama = null;
    }
  }

  private async stopGenerations(): Promise<void> {
    for (const controller of this.generations) controller.abort();
    await this.activeRun;
  }

  private async unloadModel(): Promise<void> {
    const { context, model } = this;
    this.context = null;
    this.model = null;
    this.chatWrapper = null;
    this.modelPath = null;
    await context?.dispose();
    await model?.dispose();
  }
}
