// Vector Store: o resto do app conversa com a interface `VectorStore`, nunca com o LanceDB direto.
// Sem dependência do Electron.
import { Field, FixedSizeList, Float32, Schema, Utf8 } from "apache-arrow";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChunkMetadata,
  ChunkWithVector,
  DeleteFilter,
  SearchFilter,
  SearchResult,
  VectorStoreInfo,
} from "../../shared/chunk";

export interface VectorStore {
  /** Cria se não existir. */
  open(): Promise<void>;
  /** Lote; idempotente por `chunk_id` (upsert). */
  insertChunks(chunks: ChunkWithVector[]): Promise<void>;
  search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<SearchResult[]>;
  count(filter?: { source?: string }): Promise<number>;
  deleteBy(filter: DeleteFilter): Promise<void>;
  /** Só acima do limiar de linhas (ver `INDEX_MIN_ROWS`). */
  createIndexIfNeeded(): Promise<void>;
  /** Junta fragmentos pequenos e apaga versões antigas (a ingestão grava em muitos commits). */
  optimize(): Promise<void>;
  getInfo(): Promise<VectorStoreInfo>;
  close(): Promise<void>;
}

export const EMBEDDING_MODEL_MISMATCH = "EMBEDDING_MODEL_MISMATCH";
export const VECTOR_DIMENSION_MISMATCH = "VECTOR_DIMENSION_MISMATCH";

/**
 * Abaixo disso a busca é exata (flat) e já é rápida; o IVF-PQ precisa de dados suficientes para
 * treinar as partições e os codebooks do PQ (256 centróides por sub-vetor).
 */
export const INDEX_MIN_ROWS = 10_000;
const TABLE = "chunks";
const META_FILE = "meta.json";
const MAX_TOP_K = 100;

const TEXT_COLUMNS = [
  "chunk_id",
  "document_id",
  "document_title",
  "section",
  "text",
  "language",
  "source",
  "dataset_version",
  "url",
] as const satisfies ReadonlyArray<keyof ChunkMetadata>;

export class VectorStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// ---- LanceDB: versão por plataforma ------------------------------------------------------------
//
// O LanceDB não publica mais binário darwin-x64 (o último é 0.22.3). Mac M e Windows usam a versão
// atual; o Mac Intel usa a 0.22.3, instalada com o alias `lancedb-intel`. A API usada aqui é a mesma
// nas duas. Atenção: no Mac Intel o `@lancedb/lancedb` atual NUNCA pode ser importado — o loader dele
// acharia o binário 0.22.3 e carregaria uma versão incompatível sem avisar.

type LanceModule = typeof import("@lancedb/lancedb");
type Connection = Awaited<ReturnType<LanceModule["connect"]>>;
type Table = Awaited<ReturnType<Connection["openTable"]>>;

export const usesLegacyLance = (platform = process.platform, arch = process.arch) =>
  platform === "darwin" && arch === "x64";

async function loadLance(): Promise<{ lance: LanceModule; engine: string }> {
  if (usesLegacyLance()) {
    const lance = (await import("lancedb-intel")) as unknown as LanceModule;
    return { lance, engine: "lancedb 0.22.3 (Mac Intel)" };
  }
  return { lance: await import("@lancedb/lancedb"), engine: "lancedb 0.39.0" };
}

// ---- helpers ------------------------------------------------------------------------------------

/** Literal SQL (DataFusion) com aspas simples escapadas. Nunca interpolar texto cru num predicado. */
export function sqlString(value: string): string {
  if (typeof value !== "string") throw new Error("Valor de filtro inválido.");
  return `'${value.replace(/'/g, "''")}'`;
}

/** Predicado `a = 'x' AND b = 'y'` só com colunas conhecidas e valores escapados. */
export function buildPredicate(filter: Partial<Record<(typeof TEXT_COLUMNS)[number], string>>): string | null {
  const parts: string[] = [];
  for (const [column, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (!(TEXT_COLUMNS as readonly string[]).includes(column)) throw new Error(`Coluna de filtro desconhecida: ${column}`);
    parts.push(`${column} = ${sqlString(value)}`);
  }
  return parts.length ? parts.join(" AND ") : null;
}

export function chunkSchema(dimensions: number): Schema {
  return new Schema([
    ...TEXT_COLUMNS.map((name) => new Field(name, new Utf8(), name === "section")),
    new Field("vector", new FixedSizeList(dimensions, new Field("item", new Float32(), true)), false),
  ]);
}

export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

interface StoreMeta {
  embeddingModel: string;
  dimensions: number;
  createdAt: string;
}

// ---- implementação ------------------------------------------------------------------------------

export interface LanceVectorStoreOptions {
  /** Diretório do banco (no app: `userData/vectordb`). */
  dir: string;
  /** Modelo de embedding atual: vetores de modelos diferentes não são comparáveis. */
  embeddingModel: string;
  dimensions: number;
  /** Testes reduzem o limiar. */
  indexMinRows?: number;
}

export class LanceVectorStore implements VectorStore {
  private readonly dir: string;
  private readonly embeddingModel: string;
  private readonly dimensions: number;
  private readonly indexMinRows: number;
  private db: Connection | null = null;
  private table: Table | null = null;
  private engine = "";
  private opening: Promise<void> | null = null;
  /** Modelo gravado na base, quando diverge do atual. */
  private mismatch: StoreMeta | null = null;
  // Escritas em fila: merge/delete/índice concorrentes no mesmo dataset geram conflito de versão.
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: LanceVectorStoreOptions) {
    this.dir = options.dir;
    this.embeddingModel = options.embeddingModel;
    this.dimensions = options.dimensions;
    this.indexMinRows = options.indexMinRows ?? INDEX_MIN_ROWS;
  }

  /** Idempotente; chamadas concorrentes compartilham a abertura. */
  open(): Promise<void> {
    if (this.table) return Promise.resolve();
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.checkMeta();
    const { lance, engine } = await loadLance();
    // Intervalo 0: cada leitura confere se outro processo (o worker de ingestão) gravou versão nova.
    const db = await lance.connect(this.dir, { readConsistencyInterval: 0 });
    const table = (await db.tableNames()).includes(TABLE)
      ? await db.openTable(TABLE)
      : await db.createEmptyTable(TABLE, chunkSchema(this.dimensions), { mode: "create", existOk: true });
    this.db = db;
    this.table = table;
    this.engine = engine;
  }

  /** `meta.json` guarda o modelo de embedding da base; divergência bloqueia busca e inserção. */
  private async checkMeta(): Promise<void> {
    const file = path.join(this.dir, META_FILE);
    let meta: StoreMeta | null = null;
    try {
      meta = JSON.parse(await readFile(file, "utf8")) as StoreMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`meta.json ilegível em ${this.dir}.`);
    }
    if (!meta) {
      const fresh: StoreMeta = {
        embeddingModel: this.embeddingModel,
        dimensions: this.dimensions,
        createdAt: new Date().toISOString(),
      };
      await writeFile(`${file}.tmp`, JSON.stringify(fresh, null, 2), "utf8");
      await rename(`${file}.tmp`, file);
      return;
    }
    const matches = meta.embeddingModel === this.embeddingModel && meta.dimensions === this.dimensions;
    this.mismatch = matches ? null : meta;
  }

  private assertCompatible(): void {
    if (this.mismatch) {
      throw new VectorStoreError(
        EMBEDDING_MODEL_MISMATCH,
        `a base foi indexada com ${this.mismatch.embeddingModel} (${this.mismatch.dimensions} dimensões) e o modelo atual é ` +
          `${this.embeddingModel} (${this.dimensions}). Reindexe a base.`,
      );
    }
  }

  private async ready(): Promise<Table> {
    await this.open();
    if (!this.table) throw new Error("Vector store fechado.");
    return this.table;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work);
    this.writes = run.catch(() => undefined);
    return run;
  }

  async insertChunks(chunks: ChunkWithVector[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.ready();
    this.assertCompatible();
    // Último vence dentro do lote: o merge do LanceDB não aceita a mesma chave duas vezes no mesmo lote.
    const byId = new Map<string, Record<string, unknown>>();
    for (const chunk of chunks) {
      if (!Array.isArray(chunk.vector) || chunk.vector.length !== this.dimensions) {
        throw new VectorStoreError(
          VECTOR_DIMENSION_MISMATCH,
          `o chunk "${chunk.chunk_id}" tem vetor com ${Array.isArray(chunk.vector) ? chunk.vector.length : "?"} posições; ` +
            `esperado ${this.dimensions}.`,
        );
      }
      if (!chunk.vector.every(Number.isFinite)) throw new Error(`O chunk "${chunk.chunk_id}" tem valores não numéricos no vetor.`);
      for (const column of TEXT_COLUMNS) {
        const value = chunk[column];
        if (column === "section" ? value !== null && typeof value !== "string" : typeof value !== "string" || !value) {
          throw new Error(`O chunk "${chunk.chunk_id}" tem o campo "${column}" inválido.`);
        }
      }
      const row: Record<string, unknown> = { vector: chunk.vector };
      for (const column of TEXT_COLUMNS) row[column] = chunk[column];
      byId.set(chunk.chunk_id, row);
    }
    await this.enqueue(() =>
      table.mergeInsert("chunk_id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([...byId.values()]),
    );
  }

  async search(queryVector: number[], topK: number, filter: SearchFilter = {}): Promise<SearchResult[]> {
    const table = await this.ready();
    this.assertCompatible();
    if (!Array.isArray(queryVector) || queryVector.length !== this.dimensions) {
      throw new VectorStoreError(VECTOR_DIMENSION_MISMATCH, `vetor de busca com ${queryVector?.length} posições; esperado ${this.dimensions}.`);
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) throw new Error(`topK deve ser um inteiro entre 1 e ${MAX_TOP_K}.`);
    let query = table.vectorSearch(queryVector).column("vector").distanceType("cosine").limit(topK);
    const predicate = buildPredicate({ source: filter.source, language: filter.language });
    if (predicate) query = query.where(predicate);
    const rows = (await query.toArray()) as Array<Record<string, unknown>>;
    // `_distance` do cosseno = 1 - similaridade: no app, maior = mais parecido.
    return rows.map((row) => {
      const result = { score: 1 - Number(row._distance) } as SearchResult;
      for (const column of TEXT_COLUMNS) (result as unknown as Record<string, unknown>)[column] = row[column] ?? null;
      return result;
    });
  }

  async count(filter: { source?: string } = {}): Promise<number> {
    const table = await this.ready();
    const predicate = buildPredicate({ source: filter.source });
    return predicate ? table.countRows(predicate) : table.countRows();
  }

  async deleteBy(filter: DeleteFilter): Promise<void> {
    const table = await this.ready();
    if (!filter?.source) throw new Error("deleteBy exige `source`.");
    const predicate = buildPredicate({
      source: filter.source,
      language: filter.language,
      dataset_version: filter.dataset_version,
    })!;
    await this.enqueue(() => table.delete(predicate));
  }

  private async hasVectorIndex(table: Table): Promise<boolean> {
    const indices = await table.listIndices();
    return indices.some((index) => index.columns.includes("vector"));
  }

  async createIndexIfNeeded(): Promise<void> {
    const table = await this.ready();
    await this.enqueue(async () => {
      const rows = await table.countRows();
      if (rows < this.indexMinRows || (await this.hasVectorIndex(table))) return;
      const { lance } = await loadLance();
      const started = Date.now();
      await table.createIndex("vector", {
        config: lance.Index.ivfPq({ distanceType: "cosine" }),
        replace: true,
      });
      console.info(`[vector] índice IVF-PQ criado para ${rows} linhas em ${Date.now() - started} ms`);
    });
  }

  async optimize(): Promise<void> {
    const table = await this.ready();
    await this.enqueue(async () => {
      const started = Date.now();
      // Versões antigas só depois de 1 minuto: um leitor em outro processo pode estar usando-as.
      await table.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000) });
      console.info(`[vector] otimizado em ${Date.now() - started} ms`);
    });
  }

  async getInfo(): Promise<VectorStoreInfo> {
    const table = await this.ready();
    return {
      rows: await table.countRows(),
      sizeOnDiskBytes: await directorySize(this.dir),
      embeddingModel: this.mismatch?.embeddingModel ?? this.embeddingModel,
      dimensions: this.mismatch?.dimensions ?? this.dimensions,
      indexed: await this.hasVectorIndex(table),
      engine: this.engine,
    };
  }

  /** Espera as escritas pendentes e libera os handles nativos. */
  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    await this.writes;
    const { table, db } = this;
    this.table = null;
    this.db = null;
    table?.close();
    db?.close();
  }
}
