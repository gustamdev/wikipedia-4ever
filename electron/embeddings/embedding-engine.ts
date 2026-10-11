// Embedding Engine (transformers.js + onnxruntime-node). Sem dependência do Electron.
// Offline-first: `install()` é o ÚNICO caminho que acessa a rede; `load()` lê só do disco.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInstallProgress, EmbeddingMode, EmbeddingStatus } from "../../shared/embeddings";

export const E5_MODEL_ID = "Xenova/multilingual-e5-small";
/** Commit fixo no Hugging Face: a instalação é reproduzível (o `main` pode mudar). */
export const E5_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const E5_DIMENSIONS = 384;
/** Pesos quantizados (onnx/model_quantized.onnx, ~118 MB): menores e mais rápidos em CPU que o fp32 (~470 MB). */
export const E5_DTYPE = "q8";
/** Acima disso o tokenizer do e5 trunca a entrada sem avisar (o excesso não entra no vetor). */
export const E5_MAX_TOKENS = 512;

/** Prefixos obrigatórios do e5: responsabilidade do engine, nunca do chamador. */
const PREFIX: Record<EmbeddingMode, string> = { query: "query: ", passage: "passage: " };
/** Lote interno padrão: limita a memória do tensor de entrada quando o chamador manda centenas de textos. */
const DEFAULT_BATCH_SIZE = 32;
const MARKER_FILE = "w4e-installed.json";

export const EMBEDDING_MODEL_NOT_INSTALLED = "EMBEDDING_MODEL_NOT_INSTALLED";

export class EmbeddingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    // O código vai no texto: é o que atravessa o IPC.
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** O pipeline `feature-extraction` do transformers.js, só com o que o engine usa. */
export interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{ tolist(): unknown }>;
  dispose(): Promise<void>;
  /** Tokenizer do modelo (o pipeline real tem; os falsos dos testes podem não ter). */
  tokenizer?: { encode(text: string): number[] };
}

export interface CreateExtractorOptions {
  modelId: string;
  revision: string;
  dtype: string;
  cacheDir: string;
  /** false = só disco (lança se faltar arquivo). */
  allowRemote: boolean;
  onProgress?: (progress: EmbeddingInstallProgress) => void;
}

export type CreateExtractor = (options: CreateExtractorOptions) => Promise<FeatureExtractor>;

interface InstallMarker {
  modelId: string;
  revision: string;
  dtype: string;
  installedAt: string;
  files: Array<{ path: string; size: number }>;
}

/** Fábrica real: importa o transformers.js só quando precisa (não pesa na abertura do app). */
export const createTransformersExtractor: CreateExtractor = async (options) => {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = options.cacheDir;
  env.localModelPath = options.cacheDir;
  env.useFSCache = true;
  env.useBrowserCache = false;
  // Na instalação, nada de "caminho local" (só cache + rede); depois, só disco.
  env.allowLocalModels = !options.allowRemote;
  env.allowRemoteModels = options.allowRemote;
  const extractor = await pipeline("feature-extraction", options.modelId, {
    revision: options.revision,
    dtype: options.dtype as "q8",
    device: "cpu",
    local_files_only: !options.allowRemote,
    progress_callback: (info) => {
      if (info.status === "progress") options.onProgress?.({ file: info.file, loaded: info.loaded, total: info.total });
    },
  });
  return extractor as unknown as FeatureExtractor;
};

export interface EmbeddingEngineOptions {
  /** Raiz do cache (no app: `userData/embedding-models`). */
  cacheDir: string;
  modelId?: string;
  revision?: string;
  dtype?: string;
  dimensions?: number;
  /** Textos por inferência (default 32). A ingestão (Semana 8) mede 32/64/128. */
  batchSize?: number;
  /** Testes injetam um pipeline falso. */
  createExtractor?: CreateExtractor;
}

export class EmbeddingEngine {
  readonly modelId: string;
  readonly revision: string;
  readonly dtype: string;
  readonly dimensions: number;
  private readonly batchSize: number;
  private readonly cacheDir: string;
  private readonly createExtractor: CreateExtractor;
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;
  private installing: Promise<void> | null = null;
  // Inferências em fila: uma por vez (memória previsível; o ORT já paraleliza dentro de cada uma).
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: EmbeddingEngineOptions) {
    this.cacheDir = options.cacheDir;
    this.modelId = options.modelId ?? E5_MODEL_ID;
    this.revision = options.revision ?? E5_REVISION;
    this.dtype = options.dtype ?? E5_DTYPE;
    this.dimensions = options.dimensions ?? E5_DIMENSIONS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error("batchSize inválido.");
    this.createExtractor = options.createExtractor ?? createTransformersExtractor;
  }

  /** Pasta do modelo no cache do transformers.js (`<cache>/<modelo>/<revisão>/…` quando a revisão não é `main`). */
  get modelDir(): string {
    return path.join(this.cacheDir, ...this.modelId.split("/"), this.revision);
  }

  private get markerPath(): string {
    return path.join(this.modelDir, MARKER_FILE);
  }

  /** Instalado = marcador gravado no fim da instalação + todos os arquivos com o tamanho registrado. */
  async isInstalled(): Promise<boolean> {
    return (await this.installedSize()) !== null;
  }

  private async installedSize(): Promise<number | null> {
    let marker: InstallMarker;
    try {
      marker = JSON.parse(await readFile(this.markerPath, "utf8")) as InstallMarker;
    } catch {
      return null;
    }
    if (marker.modelId !== this.modelId || marker.revision !== this.revision || marker.dtype !== this.dtype) return null;
    if (!Array.isArray(marker.files) || marker.files.length === 0) return null;
    let total = 0;
    for (const file of marker.files) {
      try {
        const info = await stat(path.join(this.modelDir, file.path));
        if (info.size !== file.size) return null;
        total += info.size;
      } catch {
        return null;
      }
    }
    return total;
  }

  async status(): Promise<EmbeddingStatus> {
    const sizeBytes = await this.installedSize();
    return {
      installed: sizeBytes !== null,
      loaded: this.extractor !== null,
      loading: this.loading !== null && this.extractor === null,
      installing: this.installing !== null,
      modelId: this.modelId,
      dimensions: this.dimensions,
      dtype: this.dtype,
      sizeBytes,
    };
  }

  /**
   * Baixa o modelo (único acesso à rede). Recomeça de uma pasta limpa: o cache do transformers.js
   * grava direto no nome final, então um download interrompido antes deixaria arquivo truncado.
   * O marcador só é gravado no fim. Chamadas concorrentes compartilham a mesma instalação.
   */
  install(onProgress: (progress: EmbeddingInstallProgress) => void): Promise<void> {
    this.installing ??= this.doInstall(onProgress).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async doInstall(onProgress: (progress: EmbeddingInstallProgress) => void): Promise<void> {
    if (await this.isInstalled()) return;
    this.assertAlive();
    // Não usa `unload()`: um `load()` concorrente espera esta instalação (esperar por ele travaria).
    const stale = this.extractor;
    this.extractor = null;
    await stale?.dispose();
    await rm(this.modelDir, { recursive: true, force: true });
    await mkdir(this.modelDir, { recursive: true });
    const extractor = await this.createExtractor({
      modelId: this.modelId,
      revision: this.revision,
      dtype: this.dtype,
      cacheDir: this.cacheDir,
      allowRemote: true,
      onProgress,
    });
    if (this.disposed) {
      await extractor.dispose();
      return;
    }
    const files = await listFiles(this.modelDir);
    if (files.length === 0) throw new Error("A instalação terminou sem nenhum arquivo no cache.");
    const marker: InstallMarker = {
      modelId: this.modelId,
      revision: this.revision,
      dtype: this.dtype,
      installedAt: new Date().toISOString(),
      files,
    };
    await writeFile(this.markerPath, JSON.stringify(marker, null, 2), "utf8");
    // O pipeline já está na memória: o primeiro `embed()` não recarrega.
    this.extractor = extractor;
  }

  /** Carrega uma única vez, só do disco (idempotente; chamadas concorrentes esperam a mesma carga). */
  async load(): Promise<void> {
    await this.getExtractor();
  }

  private getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return Promise.resolve(this.extractor);
    this.loading ??= this.doLoad().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doLoad(): Promise<FeatureExtractor> {
    this.assertAlive();
    await this.installing?.catch(() => undefined);
    if (this.extractor) return this.extractor;
    if (!(await this.isInstalled())) {
      throw new EmbeddingError(
        EMBEDDING_MODEL_NOT_INSTALLED,
        "o modelo de embeddings não está instalado. Baixe-o primeiro (Configurações).",
      );
    }
    const started = Date.now();
    const extractor = await this.createExtractor({
      modelId: this.modelId,
      revision: this.revision,
      dtype: this.dtype,
      cacheDir: this.cacheDir,
      allowRemote: false,
    });
    if (this.disposed) {
      await extractor.dispose();
      throw new Error("O engine de embeddings foi encerrado.");
    }
    console.info(`[embeddings] ${this.modelId} (${this.dtype}) carregado em ${Date.now() - started} ms`);
    this.extractor = extractor;
    return extractor;
  }

  /** Um vetor normalizado (norma 1) por texto, na mesma ordem. Aplica o prefixo e5 de `mode`. */
  async embed(texts: string[], mode: EmbeddingMode): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) throw new Error("texts deve ser string[].");
    if (mode !== "query" && mode !== "passage") throw new Error(`mode inválido: ${String(mode)}`);
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const prefixed = texts.map((t) => PREFIX[mode] + t);

    const run = this.queue.then(async () => {
      const vectors: number[][] = [];
      for (let i = 0; i < prefixed.length; i += this.batchSize) {
        this.assertAlive();
        const output = await extractor(prefixed.slice(i, i + this.batchSize), { pooling: "mean", normalize: true });
        vectors.push(...toVectors(output.tolist(), this.dimensions));
      }
      return vectors;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Tokens reais de cada texto como o modelo os vê (prefixo e tokens especiais incluídos), para o
   * chamador evitar o truncamento silencioso acima de `E5_MAX_TOKENS`. `null` se o pipeline não
   * expõe o tokenizer.
   */
  async countTokens(texts: string[], mode: EmbeddingMode): Promise<number[] | null> {
    const extractor = await this.getExtractor();
    const tokenizer = extractor.tokenizer;
    if (!tokenizer) return null;
    return texts.map((t) => tokenizer.encode(PREFIX[mode] + t).length);
  }

  /** Tira o modelo da memória (o cache em disco fica). */
  async unload(): Promise<void> {
    await this.loading?.catch(() => undefined);
    await this.queue;
    const extractor = this.extractor;
    this.extractor = null;
    await extractor?.dispose();
  }

  /** Encerramento do app: descarrega e recusa trabalho novo. Uma instalação em andamento é abandonada. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("O engine de embeddings foi encerrado.");
  }
}

function toVectors(list: unknown, dimensions: number): number[][] {
  if (!Array.isArray(list)) throw new Error("Saída inesperada do pipeline de embeddings.");
  return list.map((row) => {
    if (!Array.isArray(row) || row.length !== dimensions) {
      throw new Error(`Vetor com ${Array.isArray(row) ? row.length : "?"} dimensões; esperado ${dimensions}.`);
    }
    return row as number[];
  });
}

/** Arquivos (com tamanho) sob `dir`, caminhos relativos, sem o marcador. */
async function listFiles(dir: string): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === MARKER_FILE) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.push({ path: path.relative(dir, full), size: (await stat(full)).size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
