// Ingestão da Wikipedia (Semana 8): contratos entre Renderer, Main e o worker (utilityProcess).

/**
 * Etapas visíveis ao usuário. "Ler → dividir → embutir → gravar" acontecem juntas, lote a lote
 * (nunca o dataset inteiro na RAM), então aparecem como uma só etapa: `embed`.
 */
export type IngestionStage = "download" | "embed" | "index";

export type IngestionState =
  | "idle"
  | "running"
  /** Cancelamento pedido; o worker termina o commit em andamento. */
  | "canceling"
  /** Cancelada ou interrompida (rede, fechar o app): o que foi gravado é utilizável e dá para retomar. */
  | "partial"
  | "completed"
  | "error";

export interface IngestionProgress {
  stage: IngestionStage;
  /** Progresso dentro da etapa, na unidade de `unit`. */
  current: number;
  total: number;
  unit: "bytes" | "articles";
  /** Artigos processados e chunks gravados até agora (a base inteira, incluindo execuções anteriores). */
  articles: number;
  chunks: number;
  /** Tempo de trabalho acumulado (soma das execuções, sem contar o tempo parado). */
  elapsedMs: number;
  etaSeconds: number | null;
  /** Só no download. */
  bytesPerSecond?: number;
  /** Nome do arquivo em andamento (download). */
  file?: string;
  /** Download: conferindo o SHA-256 do arquivo já baixado. */
  verifying?: boolean;
}

export interface IngestionRequest {
  language: string;
  /** Default: `DEFAULT_SNAPSHOT`. */
  snapshot?: string;
  /** Apaga os Parquets brutos depois de indexar. */
  deleteRaw?: boolean;
}

/** Resumo mostrado ao fim (e guardado na base de conhecimento). */
export interface IngestionSummary {
  language: string;
  snapshot: string;
  articles: number;
  chunks: number;
  /** Trechos maiores que o limite do modelo de embedding (o fim deles não entrou no vetor). */
  truncatedChunks: number;
  vectors: number;
  sizeOnDiskBytes: number;
  elapsedMs: number;
  chunksPerSecond: number;
}

export interface IngestionStatus {
  state: IngestionState;
  language: string | null;
  snapshot: string | null;
  progress: IngestionProgress | null;
  error: string | null;
  /** Há estado salvo que "Retomar" continua. */
  resumable: boolean;
  summary: IngestionSummary | null;
}

export interface IngestionEstimate {
  language: string;
  snapshot: string;
  /** Soma dos Parquets (`lfs.size` do Hugging Face): exato. */
  rawBytes: number;
  /** Quanto dos Parquets já está no disco (não precisa baixar de novo). */
  alreadyDownloadedBytes: number;
  /** Estimativas (ver `estimateBasis`). */
  articlesApprox: number;
  chunksApprox: number;
  estimatedVectorBytes: number;
  estimatedIndexBytes: number;
  /** Espaço que ainda será ocupado: o que falta baixar + vetores + índice. */
  totalBytes: number;
  freeBytes: number;
  sufficient: boolean;
  /** `measured`: o idioma foi medido na Semana 7; `rough`: média dos idiomas medidos. */
  estimateBasis: "measured" | "rough";
}

export interface DatasetLanguage {
  /** Código do dataset (ex.: "pt", "simple", "zh-min-nan"). */
  code: string;
  snapshot: string;
}

export const DEFAULT_SNAPSHOT = "20231101";
export const INGESTION_SOURCE = "wikipedia";

/** Registro em `config.json`. */
export interface KnowledgeBase {
  id: string;
  language: string;
  snapshot: string;
  status: "complete" | "partial";
  documents: number;
  chunks: number;
  sizeOnDiskBytes: number;
  embeddingModel: string;
  createdAt: string;
}

export function knowledgeBaseId(language: string): string {
  return `wikipedia-${language}`;
}

// ---- worker ------------------------------------------------------------------------------------

/** Caminhos que o Main entrega ao worker (ele não conhece o Electron). */
export interface WorkerPaths {
  datasetsDir: string;
  stateFile: string;
  vectorDir: string;
  embeddingCacheDir: string;
}

export interface WorkerStartMessage {
  type: "start";
  request: IngestionRequest & { snapshot: string };
  paths: WorkerPaths;
  /** Textos por lote de embeddings (default 64). */
  batchSize?: number;
  /** Retoma o estado salvo em vez de recomeçar. */
  resume: boolean;
}

export type MainToWorker = WorkerStartMessage | { type: "cancel" };

export type WorkerToMain =
  | { type: "progress"; progress: IngestionProgress }
  | { type: "done"; summary: IngestionSummary }
  /** Parou antes do fim (cancelamento): o parcial está gravado. */
  | { type: "canceled"; articles: number; chunks: number }
  | { type: "error"; message: string; articles: number; chunks: number };
