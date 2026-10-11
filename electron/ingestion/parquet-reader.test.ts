// Leitor de Parquet contra um arquivo real do dataset em dev-data/ (baixado na Semana 7; não versionado).
// Sem o arquivo, os testes são pulados.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { countRows, readArticles, sampleArticles } from "./parquet-reader.ts";

const dir = path.join(import.meta.dirname, "..", "..", "dev-data");
const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".parquet")) : undefined;
const skip = !file && "sem arquivo .parquet em dev-data/";
const parquet = file ? path.join(dir, file) : "";

test("countRows lê só os metadados", { skip }, async () => {
  assert.ok((await countRows(parquet)) > 1000);
});

test("readArticles: lotes, limite e colunas preenchidas", { skip }, async () => {
  const sizes: number[] = [];
  const ids = new Set<string>();
  for await (const batch of readArticles(parquet, { batchSize: 64, limit: 1500 })) {
    sizes.push(batch.length);
    for (const a of batch) {
      assert.ok(a.id && a.title && a.url.startsWith("https://") && typeof a.text === "string");
      ids.add(a.id);
    }
  }
  assert.equal(sizes.reduce((s, n) => s + n, 0), 1500);
  assert.ok(sizes.every((n) => n <= 64));
  assert.equal(ids.size, 1500, "sem repetição entre row groups");
});

test("sampleArticles espalha a amostra pelo arquivo", { skip }, async () => {
  const sample = await sampleArticles(parquet, 3000);
  assert.equal(sample.length, 3000);
  const first: string[] = [];
  for await (const batch of readArticles(parquet, { limit: 3000 })) first.push(...batch.map((a) => a.id));
  const overlap = sample.filter((a) => first.includes(a.id)).length;
  assert.ok(overlap < 3000, "não são só os primeiros artigos");
});

test("readArticles com skip continua exatamente do ponto pedido", { skip }, async () => {
  const total = await countRows(parquet);
  const offset = Math.min(total - 150, 25_000);
  const all: string[] = [];
  for await (const batch of readArticles(parquet, { limit: offset + 100 })) all.push(...batch.map((a) => a.id));
  const resumed: string[] = [];
  for await (const batch of readArticles(parquet, { batchSize: 30, skip: offset, limit: 100 })) resumed.push(...batch.map((a) => a.id));
  assert.deepEqual(resumed, all.slice(offset, offset + 100));
  // skip além do fim: nada.
  const none: string[] = [];
  for await (const batch of readArticles(parquet, { skip: total })) none.push(...batch.map((a) => a.id));
  assert.equal(none.length, 0);
});
