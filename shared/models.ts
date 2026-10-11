// Tipos de modelos e downloads compartilhados entre Main e Renderer (apenas tipos/constantes puras).

export interface CatalogModel {
  id: string;
  name: string;
  developer: string;
  /** Identificador da licença (ex.: "apache-2.0", "llama3.2", "mit", "qwen-research"). */
  license: string;
  /** Uma linha sobre redistribuição/uso comercial. */
  licenseSummary: string;
  licenseUrl: string;
  /** https://huggingface.co/<repo>/resolve/main/<arquivo>.gguf */
  downloadUrl: string;
  /** Da API do Hugging Face (`lfs.size`). */
  sizeBytes: number;
  /** Da API do Hugging Face (`lfs.oid`). */
  sha256: string;
  quantization: "Q4_K_M";
  /** Aproximação inicial (tamanho do arquivo × 2, arredondado); revalidada na Semana 12. */
  recommendedRamBytes: number;
  /** Máximo suportado pelo modelo (card / metadados GGUF). */
  contextWindow: number;
  languages: string[];
}

export type DownloadState =
  | "idle"
  | "queued"
  | "downloading"
  | "paused"
  | "verifying"
  | "completed"
  | "error"
  | "canceled";

/** Evento `download:progress` (genérico: serve para modelos e, na Semana 8, para Parquet). */
export interface DownloadProgress {
  id: string;
  state: DownloadState;
  /** Bytes já no disco (ou já verificados, durante `verifying`). */
  bytesDownloaded: number;
  totalBytes: number | null;
  /** Velocidade numa janela deslizante de 5 s. */
  bytesPerSecond: number;
  etaSeconds: number | null;
  error?: string;
}

export type ModelState =
  | "not_installed"
  | "queued"
  | "downloading"
  | "paused"
  | "verifying"
  | "installed"
  | "error";

export interface ModelStatus {
  state: ModelState;
  /** 0–1 */
  progress?: number;
  error?: string;
  bytesDownloaded?: number;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
}

export type ModelListItem = CatalogModel & { status: ModelStatus; isDefault: boolean };

export type ActiveModelState = "none" | "loading" | "ready" | "error";

/** Modelo carregado no runtime (no máximo um). */
export interface ActiveModel {
  /** Id do catálogo; null quando nenhum (ou quando é o override de dev `W4E_DEV_MODEL`). */
  id: string | null;
  /** Nome para exibição (nome do catálogo ou do arquivo de dev). */
  name: string | null;
  state: ActiveModelState;
  error?: string;
}

/** Converte um evento de download no status exibido para um modelo. */
export function modelStatusFromProgress(p: DownloadProgress): ModelStatus {
  const progress = p.totalBytes ? Math.min(1, p.bytesDownloaded / p.totalBytes) : undefined;
  const base = {
    progress,
    bytesDownloaded: p.bytesDownloaded,
    bytesPerSecond: p.bytesPerSecond,
    etaSeconds: p.etaSeconds,
    ...(p.error ? { error: p.error } : {}),
  };
  switch (p.state) {
    case "completed":
      return { state: "installed" };
    case "canceled":
    case "idle":
      return { state: "not_installed" };
    default:
      return { state: p.state, ...base };
  }
}
