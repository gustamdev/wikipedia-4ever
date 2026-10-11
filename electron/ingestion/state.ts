// `ingestion-state.json`: o que a ingestão precisa para retomar (arquivo atual, último commit
// confirmado, contagens). Escrita atômica (`.tmp` + `rename`). Sem dependência do Electron.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetFile } from "./hf-datasets";

export interface PersistedIngestion {
  version: 1;
  language: string;
  snapshot: string;
  deleteRaw: boolean;
  /** Lista oficial do Hugging Face guardada na primeira execução (a retomada funciona offline). */
  files: DatasetFile[];
  /** Apêndices aprendidos na amostra do idioma: fixos, para a retomada chunkar igual. */
  learnedAppendices: string[];
  /** Artigos de cada arquivo (do rodapé do Parquet); null até o download terminar. */
  fileArticleCounts: number[] | null;
  /** Arquivo em andamento (índice em `files`). */
  fileIndex: number;
  /** Artigos já confirmados (gravados) no arquivo em andamento. */
  articlesInFile: number;
  /** Totais confirmados em toda a ingestão. */
  articles: number;
  chunks: number;
  /** Trechos que passaram do limite do modelo mesmo sem contexto (ausente em estados antigos). */
  truncatedChunks?: number;
  /** Tempo de trabalho acumulado das execuções anteriores, em ms. */
  workMs: number;
  phase: "embed" | "index" | "done";
  startedAt: string;
  updatedAt: string;
}

function isState(value: unknown): value is PersistedIngestion {
  const v = value as PersistedIngestion;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    typeof v.language === "string" &&
    typeof v.snapshot === "string" &&
    Array.isArray(v.files) &&
    Array.isArray(v.learnedAppendices) &&
    Number.isInteger(v.fileIndex) &&
    Number.isInteger(v.articlesInFile) &&
    Number.isInteger(v.articles) &&
    Number.isInteger(v.chunks) &&
    typeof v.workMs === "number" &&
    (v.phase === "embed" || v.phase === "index" || v.phase === "done")
  );
}

export class IngestionStateStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** `null` se não existe ou está ilegível (nesse caso não há o que retomar). */
  async load(): Promise<PersistedIngestion | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return isState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(state: PersistedIngestion): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
