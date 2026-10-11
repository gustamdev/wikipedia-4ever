// RAG Engine: cola entre embeddings, vector store e LLM. Sem dependência do Electron; tudo entra por
// `RagDeps` (testável com falsos).
//
//   pergunta → normaliza → embed(query) → top-K → score mínimo → orçamento de tokens
//   → [sistema, histórico, contexto + pergunta] → LLM (streaming) → resposta + fontes
//
// Orçamento (tokens reais do modelo carregado, com o chat template):
//   total ≤ contextSize − answerReserveTokens;  trechos ≤ contextSize × contextBudgetRatio.
// Trechos entram por score até o orçamento acabar; o histórico entra do mais novo para o mais
// antigo no que sobrar. Fontes = exatamente os trechos que entraram no prompt.
import type { SearchResult } from "../../shared/chunk";
import type { ChatMessage } from "../../shared/electron-api";
import { DEFAULT_RAG_PARAMS, type RagParams, type RagSource } from "../../shared/rag.ts";
import { NO_CONTEXT, promptKey, RAG_CONTEXT, resolvePrompt } from "../agents/prompts.ts";

export const RAG_SYSTEM_PROMPT = "rag-system@1";

export interface RagDeps {
  embedQuery(text: string): Promise<number[]>;
  search(vector: number[], topK: number): Promise<SearchResult[]>;
  /** Tokens do prompt com o chat template do modelo carregado. */
  countPromptTokens(messages: ChatMessage[]): Promise<number>;
  countTextTokens(text: string): Promise<number>;
  contextSize(): Promise<number>;
  generate(options: { messages: ChatMessage[]; signal: AbortSignal; onTextChunk: (chunk: string) => void }): Promise<{
    text: string;
    canceled: boolean;
  }>;
  /** Idioma da interface (mensagem de "não encontrei"). */
  locale(): string;
  params?: () => RagParams;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RagAnswerInput {
  /** Conversa anterior (user/assistant), sem o prompt de sistema e sem a pergunta atual. */
  messages: ChatMessage[];
  question: string;
  signal: AbortSignal;
  onToken: (chunk: string) => void;
}

export interface RagTokenUsage {
  /** Sistema + pergunta (sem trechos nem histórico). */
  base: number;
  context: number;
  history: number;
  total: number;
  /** Teto do prompt: contextSize − answerReserveTokens. */
  limit: number;
  contextSize: number;
}

export interface RagAnswer {
  text: string;
  canceled: boolean;
  sources: RagSource[];
  usedRag: boolean;
  /** Nenhum trecho passou do score mínimo (ou coube no contexto): resposta fixa, sem chamar o modelo. */
  noContext: boolean;
  /** `rag-system@1+rag-context@1` ou `no-context@1`. */
  promptVersion: string;
  /** Ids recuperados acima do score mínimo (inclusive os que não couberam). */
  retrieved: Array<{ chunk_id: string; score: number }>;
  tokens: RagTokenUsage | null;
  timings: { embedMs: number; searchMs: number; generateMs: number; promptTokens: number; outputTokens: number };
}

/** Espaços e quebras colapsados; o resto da pergunta fica como o usuário escreveu. */
export function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

export class RagEngine {
  private readonly deps: RagDeps;

  constructor(deps: RagDeps) {
    this.deps = deps;
  }

  private params(): RagParams {
    return this.deps.params?.() ?? DEFAULT_RAG_PARAMS;
  }

  async answer(input: RagAnswerInput): Promise<RagAnswer> {
    const params = this.params();
    const question = normalizeQuestion(input.question);
    if (!question) throw new Error("Pergunta vazia.");
    const timings = { embedMs: 0, searchMs: 0, generateMs: 0, promptTokens: 0, outputTokens: 0 };

    let t = performance.now();
    const vector = await this.deps.embedQuery(question);
    timings.embedMs = Math.round(performance.now() - t);
    t = performance.now();
    const results = await this.deps.search(vector, params.topK);
    timings.searchMs = Math.round(performance.now() - t);

    const relevant = results.filter((r) => r.score >= params.minScore).sort((a, b) => b.score - a.score);
    const retrieved = relevant.map((r) => ({ chunk_id: r.chunk_id, score: r.score }));
    this.log(
      `busca: ${results.length} resultados, ${relevant.length} ≥ ${params.minScore} ` +
        `(${results.map((r) => r.score.toFixed(3)).join(", ") || "nenhum"})`,
    );
    if (input.signal.aborted) return this.canceled(retrieved, timings);

    const system: ChatMessage = { role: "system", content: resolvePrompt(RAG_SYSTEM_PROMPT).build({ now: this.deps.now?.() ?? new Date() }) };
    const plan = relevant.length > 0 ? await this.fit(system, input.messages, question, relevant, params) : null;
    if (!plan || plan.sources.length === 0) return this.noContext(input, retrieved, timings);
    if (input.signal.aborted) return this.canceled(retrieved, timings);

    this.log(
      `prompt: ${plan.tokens.total}/${plan.tokens.limit} tokens (base ${plan.tokens.base}, trechos ${plan.tokens.context}, ` +
        `histórico ${plan.tokens.history}) · fontes ${plan.sources.map((s) => s.chunk_id).join(", ")}`,
    );
    timings.promptTokens = plan.tokens.total;
    t = performance.now();
    const result = await this.deps.generate({ messages: plan.messages, signal: input.signal, onTextChunk: input.onToken });
    timings.generateMs = Math.round(performance.now() - t);
    timings.outputTokens = result.text ? await this.deps.countTextTokens(result.text) : 0;

    return {
      text: result.text,
      canceled: result.canceled,
      sources: plan.sources,
      usedRag: true,
      noContext: false,
      promptVersion: `${RAG_SYSTEM_PROMPT}+${promptKey(RAG_CONTEXT)}`,
      retrieved,
      tokens: plan.tokens,
      timings,
    };
  }

  /** Escolhe trechos e histórico que cabem no orçamento, contando com o tokenizer do modelo. */
  private async fit(
    system: ChatMessage,
    history: ChatMessage[],
    question: string,
    relevant: SearchResult[],
    params: RagParams,
  ): Promise<{ messages: ChatMessage[]; sources: RagSource[]; tokens: RagTokenUsage }> {
    const contextSize = await this.deps.contextSize();
    const limit = contextSize - params.answerReserveTokens;
    const contextBudget = Math.floor(contextSize * params.contextBudgetRatio);
    const user = (chunks: SearchResult[]): ChatMessage => ({ role: "user", content: RAG_CONTEXT.format(chunks, question) });
    const count = (messages: ChatMessage[]) => this.deps.countPromptTokens(messages);

    const base = await count([system, user([])]);
    let chunks: SearchResult[] = [];
    let withChunks = base;
    for (const candidate of relevant.slice(0, params.maxContextChunks)) {
      const total = await count([system, user([...chunks, candidate])]);
      if (total - base > contextBudget || total > limit) break; // por ordem de score: o orçamento acabou
      chunks = [...chunks, candidate];
      withChunks = total;
    }

    const current = user(chunks);
    // Histórico do mais novo para o mais antigo enquanto couber; começa sempre numa pergunta.
    let kept: ChatMessage[] = [];
    let total = withChunks;
    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = [history[i], ...kept];
      const tokens = await count([system, ...candidate, current]);
      if (tokens > limit) break;
      kept = candidate;
      total = tokens;
    }
    while (kept.length > 0 && kept[0].role !== "user") {
      kept = kept.slice(1);
      total = await count([system, ...kept, current]);
    }

    const messages = [system, ...kept, current];
    if (total > limit) throw new Error(`O prompt (${total} tokens) não cabe no contexto do modelo (${limit} disponíveis).`);
    return {
      messages,
      sources: chunks.map((c) => ({
        chunk_id: c.chunk_id,
        document_title: c.document_title,
        section: c.section,
        url: c.url,
        text: c.text,
        score: c.score,
      })),
      tokens: { base, context: withChunks - base, history: total - withChunks, total, limit, contextSize },
    };
  }

  private noContext(input: RagAnswerInput, retrieved: RagAnswer["retrieved"], timings: RagAnswer["timings"]): RagAnswer {
    const text = NO_CONTEXT.build(this.deps.locale());
    input.onToken(text);
    this.log("nenhum trecho relevante: resposta fixa de \"não encontrei\"");
    return { text, canceled: false, sources: [], usedRag: true, noContext: true, promptVersion: promptKey(NO_CONTEXT), retrieved, tokens: null, timings };
  }

  private canceled(retrieved: RagAnswer["retrieved"], timings: RagAnswer["timings"]): RagAnswer {
    return { text: "", canceled: true, sources: [], usedRag: true, noContext: false, promptVersion: RAG_SYSTEM_PROMPT, retrieved, tokens: null, timings };
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.info(`[rag] ${l}`)))(line);
  }
}
