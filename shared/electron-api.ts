// Contrato de window.electronAPI (implementado em electron/preload.ts).
import type { AgentInfo } from "./agents";
import type { Conversation, Message } from "./chat";
import type { VectorSearchResponse, VectorStoreInfo } from "./chunk";
import type { EmbeddingInstallProgress, EmbeddingStatus, SimilarityResult } from "./embeddings";
import type {
  DatasetLanguage,
  IngestionEstimate,
  IngestionProgress,
  IngestionStatus,
  KnowledgeBase,
} from "./ingestion";
import type { ActiveModel, DownloadProgress, ModelListItem } from "./models";
import type { HardwareInfo } from "./system";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** `llm:generate` aceita um prompt simples (Semana 1) ou o histórico completo (Semana 3). */
export type GenerateInput = string | { messages: ChatMessage[] };

export interface LlmTokenEvent {
  requestId: string;
  chunk: string;
}

export interface LlmDoneEvent {
  requestId: string;
  fullText: string;
  canceled: boolean;
}

export interface LlmErrorEvent {
  requestId: string;
  message: string;
}

export type Unsubscribe = () => void;

export interface ElectronAPI {
  ping(): Promise<string>;
  llm: {
    generate(requestId: string, input: GenerateInput): Promise<{ requestId: string }>;
    cancel(requestId: string): Promise<void>;
    onToken(cb: (e: LlmTokenEvent) => void): Unsubscribe;
    onDone(cb: (e: LlmDoneEvent) => void): Unsubscribe;
    onError(cb: (e: LlmErrorEvent) => void): Unsubscribe;
  };
  models: {
    list(): Promise<ModelListItem[]>;
    /** Enfileira o download (no-op se já instalado). */
    install(id: string): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    /** Interrompe e apaga o arquivo parcial. */
    cancel(id: string): Promise<void>;
    /** Descarrega (se ativo) e apaga o modelo instalado. */
    remove(id: string): Promise<void>;
    setDefault(id: string): Promise<void>;
    /** Resolve quando o modelo estiver pronto (troca descarrega o anterior). */
    load(id: string): Promise<void>;
    active(): Promise<ActiveModel>;
    onActiveChanged(cb: (e: ActiveModel) => void): Unsubscribe;
    /** Instalados/padrão mudaram (instalação concluída, remoção, novo padrão). */
    onChanged(cb: () => void): Unsubscribe;
    onDownloadProgress(cb: (e: DownloadProgress) => void): Unsubscribe;
  };
  system: {
    hardware(): Promise<HardwareInfo>;
  };
  /** Conversas persistidas. O streaming usa os eventos `llm.onToken/onDone/onError` com o mesmo requestId. */
  chat: {
    create(title?: string): Promise<Conversation>;
    list(): Promise<Conversation[]>;
    messages(conversationId: string): Promise<Message[]>;
    rename(conversationId: string, title: string): Promise<void>;
    delete(conversationId: string): Promise<void>;
    /** Apaga as mensagens e mantém a conversa (`/clear`). */
    clear(conversationId: string): Promise<void>;
    /** Persiste a pergunta, gera com streaming e resolve com a resposta gravada (null se cancelada vazia). */
    send(conversationId: string, requestId: string, content: string): Promise<Message | null>;
    cancel(requestId: string): Promise<void>;
    regenerate(conversationId: string, requestId: string): Promise<Message | null>;
    /** `conversationId` null: só define o agente das próximas conversas. */
    setAgent(conversationId: string | null, agentId: string): Promise<void>;
    onChanged(cb: (e: { conversationId: string | null }) => void): Unsubscribe;
  };
  embeddings: {
    status(): Promise<EmbeddingStatus>;
    /** Único caminho que acessa a rede; resolve ao terminar. */
    install(): Promise<void>;
    /** Os dois textos como `passage`. Carrega o modelo na primeira chamada. */
    similarity(a: string, b: string): Promise<SimilarityResult>;
    onInstallProgress(cb: (e: EmbeddingInstallProgress) => void): Unsubscribe;
  };
  /** Vector store (Semana 6): por enquanto só o painel de desenvolvedor usa. */
  vector: {
    loadTestData(): Promise<{ inserted: number }>;
    clearTestData(): Promise<void>;
    /** A pergunta é embutida com `mode: 'query'`. */
    search(query: string, topK: number): Promise<VectorSearchResponse>;
    info(): Promise<VectorStoreInfo>;
  };
  /** Indexação da Wikipedia (Semana 8): roda num processo separado; o app continua utilizável. */
  ingestion: {
    languages(): Promise<DatasetLanguage[]>;
    /** Tamanho dos Parquets (exato) e do resto (estimado), contra o espaço livre. */
    estimate(language: string): Promise<IngestionEstimate>;
    /** Recusa se o espaço não couber ou se já houver uma indexação. */
    start(language: string, options?: { deleteRaw?: boolean }): Promise<void>;
    cancel(): Promise<void>;
    resume(): Promise<void>;
    status(): Promise<IngestionStatus>;
    knowledgeBases(): Promise<KnowledgeBase[]>;
    onProgress(cb: (e: IngestionProgress) => void): Unsubscribe;
    onStatusChanged(cb: () => void): Unsubscribe;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
    /** Agente que conversas novas vão usar (o último escolhido). */
    lastUsed(): Promise<string>;
  };
  app: {
    /** Abre http/https no navegador do sistema (nunca navega a janela do app). */
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
  };
}
