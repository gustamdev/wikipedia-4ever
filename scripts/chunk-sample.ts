// Lote pequeno da Semana 7: artigos reais → chunks com metadados (sem embeddings, sem LanceDB).
// Uso:
//   npm run chunk:sample -- <arquivo.parquet> <idioma> [artigos=300] [--tokenizer <cache do e5>] [--memory]
// Grava dev-data/chunks-sample-<idioma>.jsonl e imprime resumo, validação e 10 chunks aleatórios.
//   --tokenizer: conta os tokens REAIS do e5 (offline, do cache instalado pelo app/Semana 5).
//   --memory:    lê o arquivo inteiro medindo a RSS a cada 20 row groups (memória estável?).
//   --learn [N]: aprende os títulos de apêndice do idioma com os N primeiros artigos (default 5000)
//                e os usa junto com a lista conferida (necessário para idiomas além de pt/en).
import { createWriteStream } from "node:fs";
import path from "node:path";
import {
  chunkArticle,
  DEFAULT_CHUNKER_OPTIONS,
  defaultEstimateTokens,
  dropSectionsFor,
  learnAppendixTitles,
  OVERLAP_MAX_TOKENS,
  type ChunkerOptions,
} from "../electron/ingestion/chunker.ts";
import { countRows, readArticles, sampleArticles } from "../electron/ingestion/parquet-reader.ts";
import type { ChunkMetadata } from "../shared/chunk.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, value && !value.startsWith("--") ? 2 : 1);
  return value ?? "";
};
const tokenizerCache = flag("--tokenizer");
const measureMemory = flag("--memory") !== undefined;
const learnArg = flag("--learn");
const [file, language, limitArg = "300"] = args;
if (!file || !language) {
  console.error("uso: npm run chunk:sample -- <arquivo.parquet> <idioma> [artigos] [--tokenizer <cache>] [--memory]");
  process.exit(1);
}
const limit = Number(limitArg);
const datasetVersion = /(\d{8})/.exec(path.basename(file))?.[1] ?? "20231101";
let opts: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS;
if (learnArg !== undefined) {
  const sampleSize = Number(learnArg) || 5000;
  // Amostra espalhada pelo arquivo (os primeiros artigos não são representativos).
  const texts = (await sampleArticles(file, sampleSize)).map((a) => a.text);
  const t0 = Date.now();
  const learned = learnAppendixTitles(texts);
  console.log(`apêndices aprendidos em ${texts.length} artigos (${Date.now() - t0} ms): ${learned.join(" | ") || "(nenhum)"}`);
  opts = { ...opts, dropSections: dropSectionsFor(language, learned) };
}
const out = path.join("dev-data", `chunks-sample-${language}.jsonl`);

// ---- chunking ---------------------------------------------------------------------------------
const writer = createWriteStream(out);
const chunks: ChunkMetadata[] = [];
const sources = new Map<string, string>(); // document_id → texto original (para os exemplos)
let articles = 0;
let emptyArticles = 0;
const started = Date.now();
for await (const batch of readArticles(file, { limit })) {
  for (const article of batch) {
    articles++;
    const result = chunkArticle(article, { language, source: "wikipedia", dataset_version: datasetVersion }, opts);
    if (result.length === 0) emptyArticles++;
    // Determinismo (critério 5): a mesma entrada gera exatamente a mesma saída.
    if (JSON.stringify(chunkArticle(article, { language, source: "wikipedia", dataset_version: datasetVersion }, opts)) !== JSON.stringify(result)) {
      throw new Error(`chunkArticle não determinística em ${article.id}`);
    }
    sources.set(article.id, article.text);
    for (const chunk of result) {
      chunks.push(chunk);
      writer.write(`${JSON.stringify(chunk)}\n`);
    }
  }
}
await new Promise<void>((resolve) => writer.end(resolve));

// ---- validação (critério 2) -------------------------------------------------------------------
const errors: string[] = [];
const ids = new Set<string>();
const tokenCap = opts.maxTokens + OVERLAP_MAX_TOKENS + 1;
for (const c of chunks) {
  for (const key of ["chunk_id", "document_id", "document_title", "text", "language", "source", "dataset_version", "url"] as const) {
    if (typeof c[key] !== "string" || !c[key].trim()) errors.push(`${c.chunk_id}: campo "${key}" vazio`);
  }
  if (c.section !== null && (typeof c.section !== "string" || !c.section.trim())) errors.push(`${c.chunk_id}: section inválida`);
  if (!c.url.startsWith("https://")) errors.push(`${c.chunk_id}: url não começa com https:// (${c.url})`);
  if (ids.has(c.chunk_id)) errors.push(`${c.chunk_id}: chunk_id duplicado`);
  ids.add(c.chunk_id);
  const tokens = defaultEstimateTokens(c.text);
  if (tokens > tokenCap) errors.push(`${c.chunk_id}: ${tokens} tokens estimados > ${tokenCap}`);
  if (/^(Referências|Ligações externas|Ver também|References|Other websites|Related pages|External links|See also)$/im.test(c.section ?? "")) {
    errors.push(`${c.chunk_id}: seção de apêndice indexada (${c.section})`);
  }
}

// ---- estatísticas -----------------------------------------------------------------------------
const sizes = chunks.map((c) => defaultEstimateTokens(c.text)).sort((a, b) => a - b);
const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor((p / 100) * sizes.length))];
const withSection = chunks.filter((c) => c.section !== null).length;
const buckets = [0, 50, 100, 200, 300, 400, 452];
console.log(`\n## ${file} (${language}, snapshot ${datasetVersion}) — ${await countRows(file)} artigos no arquivo`);
console.log(`artigos processados: ${articles} (${emptyArticles} sem nenhum chunk) · chunks: ${chunks.length} · ${(chunks.length / articles).toFixed(2)} por artigo · ${Date.now() - started} ms`);
console.log(`tokens estimados (por escrita): média ${(sizes.reduce((s, x) => s + x, 0) / sizes.length).toFixed(1)} · mín ${sizes[0]} · p50 ${pct(50)} · p95 ${pct(95)} · máx ${sizes.at(-1)}`);
console.log(
  "distribuição:",
  buckets.slice(0, -1).map((lo, i) => `${lo}–${buckets[i + 1] - 1}: ${sizes.filter((s) => s >= lo && s < buckets[i + 1]).length}`).join(" · "),
);
console.log(`chunks com section não nula: ${((100 * withSection) / chunks.length).toFixed(1)}%`);
console.log(`validação: ${errors.length === 0 ? "✅ nenhum problema" : `❌ ${errors.length} problemas`}`);
for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
console.log(`saída: ${out}`);

// ---- tokens reais do e5 -----------------------------------------------------------------------
if (tokenizerCache) {
  const { env, AutoTokenizer } = await import("@huggingface/transformers");
  const { E5_MODEL_ID, E5_REVISION } = await import("../electron/embeddings/embedding-engine.ts");
  env.cacheDir = tokenizerCache;
  env.localModelPath = tokenizerCache;
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(E5_MODEL_ID, { revision: E5_REVISION, local_files_only: true });
  const real = chunks.map((c) => tokenizer.encode(`passage: ${c.text}`).length).sort((a, b) => a - b);
  const ratio = chunks.reduce((s, c) => s + c.text.length, 0) / real.reduce((s, x) => s + x, 0);
  console.log(
    `tokens REAIS do e5 (com "passage: " e especiais): média ${(real.reduce((s, x) => s + x, 0) / real.length).toFixed(1)} · p95 ${real[Math.floor(0.95 * real.length)]} · máx ${real.at(-1)} · acima de 512: ${real.filter((t) => t > 512).length} · ${ratio.toFixed(2)} caracteres/token`,
  );
}

// ---- 10 chunks aleatórios (semente fixa) ------------------------------------------------------
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
console.log("\n### 10 chunks aleatórios");
for (let i = 0; i < 10 && chunks.length; i++) {
  const c = chunks[Math.floor(rand() * chunks.length)];
  console.log(`\n[${c.chunk_id}] ${c.document_title} — ${c.section ?? "(introdução)"} · ${defaultEstimateTokens(c.text)} tokens est.\n${c.text}`);
}

// ---- memória (critério 7) ---------------------------------------------------------------------
if (measureMemory) {
  const samples: number[] = [];
  let rows = 0;
  const t0 = Date.now();
  for await (const batch of readArticles(file, { batchSize: 1000 })) {
    rows += batch.length;
    if ((rows / 1000) % 20 === 0) samples.push(process.memoryUsage().rss);
  }
  const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
  console.log(
    `\nmemória ao ler o arquivo inteiro (${rows} artigos, ${Date.now() - t0} ms): RSS a cada 20 row groups = ${samples.map(mb).join(", ")}`,
  );
}
