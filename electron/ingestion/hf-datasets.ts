// Listagem dos Parquets da Wikipedia no Hugging Face (`wikimedia/wikipedia`). Sem dependência do Electron.
// Tamanho e SHA-256 vêm da API (`lfs.size`/`lfs.oid`); o DownloadManager confere os dois.
import type { DatasetLanguage } from "../../shared/ingestion";

export const HF_DATASET = "wikimedia/wikipedia";
const API = `https://huggingface.co/api/datasets/${HF_DATASET}/tree/main`;
const RESOLVE = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main`;
const LANGUAGE_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
const SNAPSHOT_PATTERN = /^\d{8}$/;

export interface DatasetFile {
  /** Nome do arquivo, ex.: "train-00000-of-00006.parquet". */
  name: string;
  url: string;
  size: number;
  sha256: string;
}

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

/** Código de idioma e snapshot vão para URL e caminho de disco: só o formato esperado passa. */
export function assertDatasetId(language: string, snapshot: string): void {
  if (!LANGUAGE_PATTERN.test(language) || language.startsWith("-") || language.endsWith("-")) {
    throw new Error(`Código de idioma inválido: "${language}".`);
  }
  if (!SNAPSHOT_PATTERN.test(snapshot)) throw new Error(`Snapshot inválido: "${snapshot}".`);
}

async function fetchTree(url: string, fetchImpl: typeof fetch): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let next: string | null = url;
  // A API pagina com `Link: <url>; rel="next"`; hoje cabe tudo numa página, mas não dependemos disso.
  for (let page = 0; next && page < 20; page++) {
    const response: Response = await fetchImpl(next, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`O Hugging Face respondeu HTTP ${response.status} em ${new URL(next).pathname}.`);
    }
    entries.push(...((await response.json()) as TreeEntry[]));
    const link: string = response.headers.get("link") ?? "";
    next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
  }
  return entries;
}

/** Idiomas disponíveis num snapshot, em ordem alfabética do código. */
export async function listLanguages(snapshot: string, fetchImpl: typeof fetch = fetch): Promise<DatasetLanguage[]> {
  assertDatasetId("xx", snapshot);
  const prefix = `${snapshot}.`;
  const languages: DatasetLanguage[] = [];
  for (const entry of await fetchTree(API, fetchImpl)) {
    if (entry.type === "directory" && entry.path.startsWith(prefix)) {
      languages.push({ code: entry.path.slice(prefix.length), snapshot });
    }
  }
  return languages.sort((a, b) => a.code.localeCompare(b.code));
}

/** Parquets de um idioma/snapshot com tamanho e SHA-256 oficiais, em ordem de nome. */
export async function listDatasetFiles(
  language: string,
  snapshot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetFile[]> {
  assertDatasetId(language, snapshot);
  const dir = `${snapshot}.${language}`;
  const files: DatasetFile[] = [];
  for (const entry of await fetchTree(`${API}/${dir}`, fetchImpl)) {
    if (entry.type !== "file" || !entry.path.endsWith(".parquet")) continue;
    const size = entry.lfs?.size ?? entry.size;
    const sha256 = entry.lfs?.oid;
    if (!size || !sha256) throw new Error(`O Hugging Face não informou tamanho/SHA-256 de ${entry.path}.`);
    const name = entry.path.slice(dir.length + 1);
    if (name.includes("/")) continue;
    files.push({ name, url: `${RESOLVE}/${dir}/${name}`, size, sha256 });
  }
  if (files.length === 0) throw new Error(`Não há dados para o idioma "${language}" no snapshot ${snapshot}.`);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
