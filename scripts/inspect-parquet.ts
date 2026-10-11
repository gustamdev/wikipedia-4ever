// Inspeção de um Parquet da Wikipedia (Semana 7): metadados + artigos reais com linhas numeradas,
// marcando linhas candidatas a título de seção. Uso:
//   npm run inspect:parquet -- <arquivo.parquet> [quantos=8] [artigos a varrer=400]
import { open } from "node:fs/promises";
import { parquetMetadataAsync } from "hyparquet";
import { readArticles } from "../electron/ingestion/parquet-reader.ts";

const [file, howMany = "8", scan = "400"] = process.argv.slice(2);
if (!file) {
  console.error("uso: npm run inspect:parquet -- <arquivo.parquet> [quantos] [varrer]");
  process.exit(1);
}

// Critério FROUXO, só para enxergar padrões (a heurística final fica no chunker.ts).
const looksLikeHeading = (line: string) =>
  line.trim().length > 0 && line.trim().length <= 80 && !/[.:;?!,]$/.test(line.trim());

const handle = await open(file, "r");
const { size } = await handle.stat();
const metadata = await parquetMetadataAsync({
  byteLength: size,
  async slice(start: number, end = size) {
    const bytes = new Uint8Array(end - start);
    await handle.read(bytes, 0, bytes.length, start);
    return bytes.buffer;
  },
});
await handle.close();
const groups = metadata.row_groups;
console.log(`arquivo: ${file}`);
console.log(`linhas: ${metadata.num_rows} · row groups: ${groups.length} · tamanho: ${(size / 1e6).toFixed(1)} MB`);
console.log(
  `codecs: ${[...new Set(groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec)))].join(", ")}`,
  `· linhas por row group (1º/último): ${groups[0]?.num_rows}/${groups.at(-1)?.num_rows}`,
  `· bytes descomprimidos do 1º row group: ${(Number(groups[0]?.total_byte_size) / 1e6).toFixed(1)} MB`,
);
console.log(`colunas: ${metadata.schema.slice(1).map((s) => s.name).join(", ")}`);

const picked = [];
for await (const batch of readArticles(file, { limit: Number(scan) })) {
  for (const article of batch) {
    const lines = article.text.split(/\r?\n/);
    const candidates = lines.filter((l, i) => looksLikeHeading(l) && lines[i - 1]?.trim() === "").length;
    if (candidates >= 4 && article.text.length > 3000) picked.push(article);
  }
}
for (const article of picked.slice(0, Number(howMany))) {
  console.log(`\n${"=".repeat(100)}\n# ${article.title} (id ${article.id}) ${article.url} · ${article.text.length} caracteres`);
  article.text.split(/\r?\n/).forEach((line, i, all) => {
    const mark = looksLikeHeading(line) ? (all[i - 1]?.trim() === "" ? "H?" : "h?") : "  ";
    const shown = line.length > 110 ? `${line.slice(0, 110)}… (${line.length})` : line;
    console.log(`${String(i + 1).padStart(4)} ${mark} │ ${JSON.stringify(shown).slice(1, -1)}`);
  });
}
