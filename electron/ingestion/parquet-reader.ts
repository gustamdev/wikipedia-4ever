// Leitura de Parquet com hyparquet (JavaScript puro: sem binário nativo, igual em macOS e Windows).
// O arquivo é lido por offset via file handle (`fs.promises.open` + `read`), nunca inteiro na RAM:
// os metadados vêm do rodapé e as linhas, um row group por vez.
import { open, type FileHandle } from "node:fs/promises";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

export interface WikiArticle {
  id: string;
  url: string;
  title: string;
  text: string;
}

export interface ReadArticlesOptions {
  /** Artigos por lote entregue ao consumidor (default 64). */
  batchSize?: number;
  /** Para depois de N artigos. */
  limit?: number;
  /** Pula os N primeiros artigos do arquivo (retomada): row groups inteiros antes do ponto nem são lidos. */
  skip?: number;
}

const COLUMNS = ["id", "url", "title", "text"];

/** `AsyncBuffer` do hyparquet sobre um file handle: cada `slice` lê só o intervalo pedido. */
interface FileBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

async function openFileBuffer(filePath: string): Promise<{ file: FileBuffer; handle: FileHandle }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const file: FileBuffer = {
      byteLength: size,
      async slice(start, end = size) {
        const length = Math.max(0, Math.min(end, size) - start);
        const bytes = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
          if (bytesRead === 0) throw new Error(`Fim inesperado do arquivo Parquet em ${start + offset}.`);
          offset += bytesRead;
        }
        return bytes.buffer;
      },
    };
    return { file, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Número de linhas, só a partir dos metadados do rodapé (sem ler as linhas). */
export async function countRows(filePath: string): Promise<number> {
  const { file, handle } = await openFileBuffer(filePath);
  try {
    const metadata = await parquetMetadataAsync(file);
    return Number(metadata.num_rows);
  } finally {
    await handle.close();
  }
}

function toArticle(row: Record<string, unknown>): WikiArticle {
  const field = (name: string) => {
    const value = row[name];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    throw new Error(`Coluna "${name}" ausente ou inválida no Parquet.`);
  };
  return { id: field("id"), url: field("url"), title: field("title"), text: field("text") };
}

/**
 * Artigos em lotes. Decodifica um row group por vez (memória proporcional ao row group, não ao
 * arquivo) e o fatia em lotes de `batchSize`. Ler intervalos menores que o row group faria o
 * hyparquet decodificar o mesmo column chunk várias vezes.
 */
export async function* readArticles(filePath: string, opts: ReadArticlesOptions = {}): AsyncGenerator<WikiArticle[]> {
  const batchSize = opts.batchSize ?? 64;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const skip = opts.skip ?? 0;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize inválido.");
  if (!Number.isInteger(skip) || skip < 0) throw new Error("skip inválido.");
  const { file, handle } = await openFileBuffer(filePath);
  try {
    const metadata = await parquetMetadataAsync(file);
    let rowStart = 0;
    let emitted = 0;
    for (const group of metadata.row_groups) {
      if (emitted >= limit) return;
      const groupRows = Number(group.num_rows);
      const groupStart = rowStart;
      rowStart += groupRows;
      if (rowStart <= skip) continue; // row group inteiro antes do ponto de retomada
      const from = Math.max(groupStart, skip);
      const rowEnd = from + Math.min(rowStart - from, limit - emitted);
      const rows = await parquetReadObjects({ file, metadata, columns: COLUMNS, rowStart: from, rowEnd, compressors });
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize).map(toArticle);
        emitted += batch.length;
        yield batch;
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Amostra representativa: row groups espaçados uniformemente pelo arquivo (os artigos vêm em ordem de
 * id, e ids próximos se parecem — ex.: páginas de datas no início do `simple`). Lê no máximo `count`.
 */
export async function sampleArticles(filePath: string, count: number): Promise<WikiArticle[]> {
  const { file, handle } = await openFileBuffer(filePath);
  try {
    const metadata = await parquetMetadataAsync(file);
    const groups = metadata.row_groups;
    const starts: number[] = [];
    let start = 0;
    for (const group of groups) {
      starts.push(start);
      start += Number(group.num_rows);
    }
    const perGroup = Math.max(1, Number(groups[0]?.num_rows ?? 1));
    const wanted = Math.min(groups.length, Math.ceil(count / perGroup));
    const sample: WikiArticle[] = [];
    for (let k = 0; k < wanted && sample.length < count; k++) {
      const g = Math.floor((k * groups.length) / wanted);
      const rowStart = starts[g];
      const rowEnd = rowStart + Math.min(Number(groups[g].num_rows), count - sample.length);
      const rows = await parquetReadObjects({ file, metadata, columns: COLUMNS, rowStart, rowEnd, compressors });
      sample.push(...rows.map(toArticle));
    }
    return sample;
  } finally {
    await handle.close();
  }
}
