// Pipeline de ingestão: baixar Parquets → ler artigos em lotes → chunkar → embutir → gravar no
// vector store → índice. Sem dependência do Electron (roda no worker e nos testes); tudo que toca
// rede, modelo ou banco entra por `PipelineDeps`.
//
// Memória: um artigo-lote do Parquet por vez + no máximo `commitSize` vetores esperando o commit.
// Retomada: o estado só avança DEPOIS que o commit no banco terminou, e cada commit contém artigos
// inteiros; o `mergeInsert` por `chunk_id` torna regravar o último commit inofensivo.
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ChunkMetadata, ChunkWithVector } from "../../shared/chunk";
import {
  INGESTION_SOURCE,
  type IngestionProgress,
  type IngestionRequest,
  type IngestionSummary,
} from "../../shared/ingestion.ts";
import {
  chunkArticle,
  DEFAULT_CHUNKER_OPTIONS,
  dropSectionsFor,
  learnAppendixTitles,
  type ChunkerOptions,
} from "./chunker.ts";
import { assertDatasetId, type DatasetFile } from "./hf-datasets.ts";
import * as parquet from "./parquet-reader.ts";
import { IngestionStateStore, type PersistedIngestion } from "./state.ts";
import type { VectorStore } from "../vector/vector-store";

export type PipelineStore = Pick<VectorStore, "insertChunks" | "deleteBy" | "optimize" | "createIndexIfNeeded" | "getInfo">;

export interface DownloadReport {
  /** Bytes do arquivo no disco (ou já verificados, em `verifying`). */
  bytes: number;
  total: number;
  bytesPerSecond: number;
  verifying: boolean;
}

export interface PipelineDeps {
  store: PipelineStore;
  /** Vetores `passage` normalizados, na ordem dos textos. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Tokens reais de cada texto `passage` (com prefixo e especiais). Sem ela, o pipeline confia na
   * estimativa do chunker; com ela, encurta o contexto de quem passaria de `maxModelTokens`.
   */
  countTokens?(texts: string[]): Promise<number[] | null>;
  /** Limite do modelo de embedding (default 512, o do e5). */
  maxModelTokens?: number;
  state: IngestionStateStore;
  /** Raiz dos datasets (`userData/datasets`); cada idioma fica em `<snapshot>.<idioma>/`. */
  datasetsDir: string;
  listFiles(language: string, snapshot: string): Promise<DatasetFile[]>;
  /** Baixa e verifica `file` em `destPath`; rejeita com `AbortError` se `signal` abortar (o parcial fica). */
  downloadFile(file: DatasetFile, destPath: string, onProgress: (report: DownloadReport) => void, signal: AbortSignal): Promise<void>;
  onProgress(progress: IngestionProgress): void;
  reader?: Pick<typeof parquet, "readArticles" | "countRows" | "sampleArticles">;
  /** Chunks por chamada de embedding (default 64). */
  batchSize?: number;
  /** Chunks por commit no banco (default 1024; ver relatório da Semana 8). */
  commitSize?: number;
  progressIntervalMs?: number;
  now?: () => number;
}

export type PipelineOutcome =
  | { type: "done"; summary: IngestionSummary }
  | { type: "canceled"; articles: number; chunks: number };

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_COMMIT_SIZE = 1024;
const READ_BATCH = 64;
const APPENDIX_SAMPLE = 5000;
/** Compacta o banco a cada tantos commits: milhares de fragmentos pequenos deixam a escrita e a busca lentas. */
const OPTIMIZE_EVERY_COMMITS = 150;
/** Prefixo `título — seção:` no texto embutido: limitado para nunca empurrar o chunk além de 512 tokens. */
const MAX_CONTEXT_CHARS = 160;

const DEFAULT_MAX_MODEL_TOKENS = 512;
/** Rechunk de um artigo cujos trechos passam do limite real: tentativas e folga sobre o limite. */
const RECHUNK_ATTEMPTS = 3;
const RECHUNK_MARGIN = 0.85;

/** Quanto contexto vai junto do trecho: tudo, só o título, ou nada (trecho no limite do modelo). */
export type ContextLevel = "full" | "title" | "none";

/**
 * Texto que vira vetor: o contexto (artigo e seção) entra no vetor; o `text` gravado continua só o
 * trecho. Dá sujeito aos trechos curtos ("Foi anunciado em 2019…"), ver relatório da Semana 7.
 */
export function embeddingInput(chunk: Pick<ChunkMetadata, "document_title" | "section" | "text">, level: ContextLevel = "full"): string {
  if (level === "none") return chunk.text;
  let context = level === "full" && chunk.section ? `${chunk.document_title} — ${chunk.section}` : chunk.document_title;
  if (context.length > MAX_CONTEXT_CHARS) context = `${context.slice(0, MAX_CONTEXT_CHARS)}…`;
  return `${context}: ${chunk.text}`;
}

export class AbortError extends Error {
  constructor() {
    super("Operação cancelada.");
    this.name = "AbortError";
  }
}

export class IngestionPipeline {
  private readonly batchSize: number;
  private readonly commitSize: number;
  private readonly progressIntervalMs: number;
  private readonly now: () => number;
  private readonly reader: NonNullable<PipelineDeps["reader"]>;
  private readonly maxModelTokens: number;

  private readonly deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.commitSize = deps.commitSize ?? DEFAULT_COMMIT_SIZE;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error("batchSize inválido.");
    if (!Number.isInteger(this.commitSize) || this.commitSize < 1) throw new Error("commitSize inválido.");
    this.progressIntervalMs = deps.progressIntervalMs ?? 500;
    this.now = deps.now ?? Date.now;
    this.reader = deps.reader ?? parquet;
    this.maxModelTokens = deps.maxModelTokens ?? DEFAULT_MAX_MODEL_TOKENS;
  }

  private datasetDir(language: string, snapshot: string): string {
    return path.join(this.deps.datasetsDir, `${snapshot}.${language}`);
  }

  /** Cancelar (signal) nunca interrompe uma escrita: o que já foi embutido é gravado antes de sair. */
  async run(request: IngestionRequest & { snapshot: string }, resume: boolean, signal: AbortSignal): Promise<PipelineOutcome> {
    const { language, snapshot } = request;
    assertDatasetId(language, snapshot);
    const deleteRaw = request.deleteRaw ?? false;
    const t0 = this.now();

    let st = resume ? await this.deps.state.load() : null;
    if (st && (st.language !== language || st.snapshot !== snapshot || st.phase === "done")) st = null;

    if (!st) {
      // Começo do zero: nada de linhas de uma tentativa anterior do mesmo idioma/snapshot.
      await this.deps.state.clear();
      await this.deps.store.deleteBy({ source: INGESTION_SOURCE, language, dataset_version: snapshot });
      const files = await this.deps.listFiles(language, snapshot);
      st = {
        version: 1,
        language,
        snapshot,
        deleteRaw,
        files,
        learnedAppendices: [],
        fileArticleCounts: null,
        fileIndex: 0,
        articlesInFile: 0,
        articles: 0,
        chunks: 0,
        truncatedChunks: 0,
        workMs: 0,
        phase: "embed",
        startedAt: new Date(this.now()).toISOString(),
        updatedAt: "",
      };
      await this.deps.state.save(st);
    }
    st.deleteRaw = deleteRaw;
    const baseWorkMs = st.workMs;
    const elapsed = () => baseWorkMs + (this.now() - t0);
    const live = { articles: st.articles, chunks: st.chunks };

    try {
      await this.download(st, signal, elapsed, live);
      if (signal.aborted) return this.canceled(st, elapsed);

      if (st.phase === "embed") {
        if (!st.fileArticleCounts) {
          st.fileArticleCounts = [];
          for (const file of st.files) st.fileArticleCounts.push(await this.reader.countRows(this.pathOf(st, file)));
          await this.save(st, elapsed);
        }
        if (st.articles === 0 && st.learnedAppendices.length === 0) {
          const sample = await this.reader.sampleArticles(this.pathOf(st, st.files[0]), APPENDIX_SAMPLE);
          st.learnedAppendices = learnAppendixTitles(sample.map((a) => a.text));
          await this.save(st, elapsed);
        }
        const finished = await this.embedAll(st, signal, elapsed);
        if (!finished) return this.canceled(st, elapsed);
        st.phase = "index";
        await this.save(st, elapsed);
      }

      if (st.phase === "index") {
        live.articles = st.articles;
        live.chunks = st.chunks;
        this.emit({ stage: "index", current: 0, total: 1, unit: "articles" }, elapsed, live, true);
        await this.deps.store.optimize();
        await this.deps.store.createIndexIfNeeded();
        st.phase = "done";
        await this.save(st, elapsed);
      }

      const info = await this.deps.store.getInfo();
      const workMs = elapsed();
      if (st.deleteRaw) await rm(this.datasetDir(language, snapshot), { recursive: true, force: true });
      await this.deps.state.clear();
      const summary: IngestionSummary = {
        language,
        snapshot,
        articles: st.articles,
        chunks: st.chunks,
        truncatedChunks: st.truncatedChunks ?? 0,
        vectors: info.rows,
        sizeOnDiskBytes: info.sizeOnDiskBytes,
        elapsedMs: workMs,
        chunksPerSecond: workMs > 0 ? Math.round((st.chunks / workMs) * 1000 * 10) / 10 : 0,
      };
      this.emit({ stage: "index", current: 1, total: 1, unit: "articles" }, elapsed, live, true);
      return { type: "done", summary };
    } catch (error) {
      if (error instanceof AbortError || signal.aborted) return this.canceled(st, elapsed);
      throw error;
    }
  }

  private pathOf(st: PersistedIngestion, file: DatasetFile): string {
    return path.join(this.datasetDir(st.language, st.snapshot), file.name);
  }

  private async save(st: PersistedIngestion, elapsed: () => number): Promise<void> {
    st.workMs = elapsed();
    await this.deps.state.save(st);
  }

  private async canceled(st: PersistedIngestion, elapsed: () => number): Promise<PipelineOutcome> {
    await this.save(st, elapsed);
    return { type: "canceled", articles: st.articles, chunks: st.chunks };
  }

  // ---- etapa 1: download -----------------------------------------------------------------------

  private async download(
    st: PersistedIngestion,
    signal: AbortSignal,
    elapsed: () => number,
    live: { articles: number; chunks: number },
  ): Promise<void> {
    const total = st.files.reduce((sum, f) => sum + f.size, 0);
    await mkdir(this.datasetDir(st.language, st.snapshot), { recursive: true });
    let doneBytes = 0;
    for (const file of st.files) {
      if (signal.aborted) return;
      const dest = this.pathOf(st, file);
      let present = 0;
      try {
        present = (await stat(dest)).size;
      } catch {
        // não existe: baixa
      }
      if (present === file.size) {
        doneBytes += file.size;
        continue; // já baixado e verificado numa execução anterior (o rename só ocorre após o SHA-256)
      }
      await this.deps.downloadFile(
        file,
        dest,
        (report) =>
          this.emit(
            {
              stage: "download",
              current: doneBytes + report.bytes,
              total,
              unit: "bytes",
              bytesPerSecond: report.bytesPerSecond,
              file: file.name,
              verifying: report.verifying,
              etaSeconds:
                report.bytesPerSecond > 0 && !report.verifying ? Math.round((total - doneBytes - report.bytes) / report.bytesPerSecond) : null,
            },
            elapsed,
            live,
            false,
          ),
        signal,
      );
      doneBytes += file.size;
    }
  }

  // ---- etapa 2: ler → chunkar → embutir → gravar --------------------------------------------------

  private lastEmit = 0;

  private emit(
    partial: Pick<IngestionProgress, "stage" | "current" | "total" | "unit"> & Partial<IngestionProgress>,
    elapsed: () => number,
    live: { articles: number; chunks: number },
    force: boolean,
  ): void {
    const t = this.now();
    if (!force && t - this.lastEmit < this.progressIntervalMs) return;
    this.lastEmit = t;
    this.deps.onProgress({
      articles: live.articles,
      chunks: live.chunks,
      elapsedMs: elapsed(),
      etaSeconds: null,
      ...partial,
    });
  }

  /** `true` = terminou todos os arquivos; `false` = cancelado (o parcial já está gravado e salvo). */
  private async embedAll(st: PersistedIngestion, signal: AbortSignal, elapsed: () => number): Promise<boolean> {
    const counts = st.fileArticleCounts!;
    const totalArticles = counts.reduce((a, b) => a + b, 0);
    const chunkerOptions: ChunkerOptions = {
      ...DEFAULT_CHUNKER_OPTIONS,
      dropSections: dropSectionsFor(st.language, st.learnedAppendices),
    };
    const meta = { language: st.language, source: INGESTION_SOURCE, dataset_version: st.snapshot } as const;
    const live = { articles: st.articles, chunks: st.chunks };
    const runStartArticles = st.articles;
    const runStart = this.now();
    let commits = 0;

    // Prontos para gravar: artigos inteiros já embutidos. `cursor` = artigos do arquivo atual consumidos.
    let ready: ChunkWithVector[] = [];
    let readyArticles = 0;
    let cursor = 0;
    let pending: ChunkMetadata[] = [];
    let pendingArticles = 0;
    // Trechos que, mesmo sem contexto, passam do limite do modelo (o fim deles não entra no vetor).
    let readyTruncated = 0;

    const report = (force: boolean) => {
      const done = st.articles + readyArticles;
      live.articles = done;
      live.chunks = st.chunks + ready.length;
      const runSeconds = (this.now() - runStart) / 1000;
      const rate = runSeconds > 0 ? (done - runStartArticles) / runSeconds : 0;
      this.emit(
        {
          stage: "embed",
          current: done,
          total: totalArticles,
          unit: "articles",
          etaSeconds: rate > 0 ? Math.round((totalArticles - done) / rate) : null,
        },
        elapsed,
        live,
        force,
      );
    };

    const commit = async () => {
      if (ready.length === 0 && readyArticles === 0) return;
      if (ready.length > 0) await this.deps.store.insertChunks(ready);
      st.articles += readyArticles;
      st.chunks += ready.length;
      st.truncatedChunks = (st.truncatedChunks ?? 0) + readyTruncated;
      st.articlesInFile = cursor;
      ready = [];
      readyArticles = 0;
      readyTruncated = 0;
      await this.save(st, elapsed);
      if (++commits % OPTIMIZE_EVERY_COMMITS === 0) await this.deps.store.optimize();
      report(true);
    };

    const embedPending = async () => {
      if (pending.length === 0) {
        readyArticles += pendingArticles;
        pendingArticles = 0;
        return;
      }
      const { inputs, truncated } = await this.fitToModel(pending);
      readyTruncated += truncated;
      const vectors = await this.embedSorted(inputs);
      pending.forEach((chunk, i) => ready.push({ ...chunk, vector: vectors[i] }));
      readyArticles += pendingArticles;
      pending = [];
      pendingArticles = 0;
      report(false);
    };

    for (let fi = st.fileIndex; fi < st.files.length; fi++) {
      // `articlesInFile` é o ponto de retomada no arquivo em andamento e 0 nos seguintes.
      const skip = st.articlesInFile;
      cursor = skip;
      for await (const batch of this.reader.readArticles(this.pathOf(st, st.files[fi]), { batchSize: READ_BATCH, skip })) {
        for (const article of batch) {
          pending.push(...(await this.chunkFitted(article, meta, chunkerOptions)));
          pendingArticles++;
          cursor++;
          if (pending.length >= this.batchSize) {
            await embedPending();
            if (ready.length >= this.commitSize) await commit();
            if (signal.aborted) {
              await commit();
              return false;
            }
          }
        }
        if (signal.aborted) {
          // `pending` (ainda não embutido) é descartado: a retomada recomeça depois do último commit.
          cursor -= pendingArticles;
          pending = [];
          pendingArticles = 0;
          await commit();
          return false;
        }
      }
      await embedPending();
      await commit();
      st.fileIndex = fi + 1;
      st.articlesInFile = 0;
      cursor = 0;
      await this.save(st, elapsed);
    }
    return true;
  }

  /**
   * O chunker mede tamanho por estimativa, que erra em escritas não calibradas (ex.: silábica Cree).
   * Se algum trecho do artigo passa do limite real do modelo (já sem prefixo de contexto), o artigo
   * inteiro é rechunkado com `maxTokens` reduzido na proporção do erro. Determinístico: mesma entrada
   * e mesmo tokenizer → mesmos chunks e ids.
   */
  private async chunkFitted(
    article: Parameters<typeof chunkArticle>[0],
    meta: Parameters<typeof chunkArticle>[1],
    options: ChunkerOptions,
  ): Promise<ChunkMetadata[]> {
    let chunks = chunkArticle(article, meta, options);
    if (!this.deps.countTokens || chunks.length === 0) return chunks;
    let maxTokens = options.maxTokens;
    for (let attempt = 0; attempt < RECHUNK_ATTEMPTS; attempt++) {
      const counts = await this.deps.countTokens(chunks.map((c) => c.text));
      if (!counts) return chunks;
      const worst = Math.max(...counts);
      if (worst <= this.maxModelTokens) return chunks;
      const next = Math.max(options.minTokens + 1, Math.floor((maxTokens * this.maxModelTokens * RECHUNK_MARGIN) / worst));
      if (next >= maxTokens) break; // já no piso do chunker
      maxTokens = next;
      chunks = chunkArticle(article, meta, { ...options, maxTokens });
    }
    return chunks; // o que ainda passar é contado como truncado em `fitToModel`
  }

  /**
   * O chunker limita o tamanho por estimativa; aqui a conta é com o tokenizer real. Quem passaria do
   * limite perde a seção do prefixo, depois o título; se nem o trecho sozinho cabe, é embutido assim
   * mesmo (o modelo trunca o fim) e contado em `truncated`.
   */
  private async fitToModel(chunks: ChunkMetadata[]): Promise<{ inputs: string[]; truncated: number }> {
    const inputs = chunks.map((c) => embeddingInput(c));
    if (!this.deps.countTokens) return { inputs, truncated: 0 };
    let over = await this.overLimit(inputs.map((_, i) => i), inputs);
    if (over === null) return { inputs, truncated: 0 };
    for (const level of ["title", "none"] as const) {
      if (over.length === 0) break;
      for (const i of over) inputs[i] = embeddingInput(chunks[i], level);
      over = (await this.overLimit(over, inputs)) ?? [];
    }
    for (const i of over) console.warn(`[ingestion] trecho acima de ${this.maxModelTokens} tokens (o fim é truncado pelo modelo): ${chunks[i].chunk_id}`);
    return { inputs, truncated: over.length };
  }

  /** Índices (dentre `indices`) cujo texto passa do limite; `null` se não dá para contar. */
  private async overLimit(indices: number[], inputs: string[]): Promise<number[] | null> {
    const counts = await this.deps.countTokens!(indices.map((i) => inputs[i]));
    if (!counts) return null;
    return indices.filter((_, k) => counts[k] > this.maxModelTokens);
  }

  /**
   * Textos parecidos em tamanho ficam no mesmo lote interno do modelo: o tensor é preenchido até o
   * texto mais longo do lote, então misturar curtos e longos desperdiça CPU.
   */
  private async embedSorted(texts: string[]): Promise<number[][]> {
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const sorted = await this.deps.embed(order.map((i) => texts[i]));
    if (sorted.length !== texts.length) throw new Error(`O embedding devolveu ${sorted.length} vetores para ${texts.length} textos.`);
    const result: number[][] = new Array(texts.length);
    order.forEach((original, position) => {
      result[original] = sorted[position];
    });
    return result;
  }
}
