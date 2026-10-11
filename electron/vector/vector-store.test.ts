// LanceVectorStore contra o LanceDB real (neste Mac Intel: 0.22.3; em Mac M/Windows: a versão atual),
// num diretório temporário com espaço e acento no path. Vetores sintéticos com vizinhos conhecidos.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ChunkWithVector } from "../../shared/chunk";
import { cosineSimilarity } from "../../shared/vector-math.ts";
import { buildPredicate, EMBEDDING_MODEL_MISMATCH, LanceVectorStore, VECTOR_DIMENSION_MISMATCH } from "./vector-store.ts";

const DIMS = 4;
const MODEL = "test-model";
let root: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "w4e vetores-ç-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function chunk(id: string, vector: number[], extra: Partial<ChunkWithVector> = {}): ChunkWithVector {
  return {
    chunk_id: id,
    document_id: id.split(":")[2] ?? id,
    document_title: `Título ${id}`,
    section: null,
    text: `texto ${id}`,
    language: "pt",
    source: "test",
    dataset_version: "v1",
    url: `test://${id}`,
    vector,
    ...extra,
  };
}

const store = (dir: string, options: Partial<{ model: string; dims: number; indexMinRows: number }> = {}) =>
  new LanceVectorStore({
    dir: path.join(root, dir),
    embeddingModel: options.model ?? MODEL,
    dimensions: options.dims ?? DIMS,
    indexMinRows: options.indexMinRows,
  });

test("vizinhos conhecidos voltam na ordem certa, com score = cosseno", async () => {
  const s = store("ordem");
  // Ângulos crescentes em relação a [1,0,0,0].
  const vectors: Record<string, number[]> = {
    a: [1, 0, 0, 0],
    b: [0.9, 0.1, 0, 0],
    c: [0.6, 0.4, 0, 0],
    d: [0, 1, 0, 0],
    e: [-1, 0, 0, 0],
  };
  await s.insertChunks(Object.entries(vectors).map(([id, v]) => chunk(`test:pt:${id}:0000`, v)));
  const query = [1, 0.05, 0, 0];
  const results = await s.search(query, 5);
  assert.deepEqual(results.map((r) => r.chunk_id.split(":")[2]), ["a", "b", "c", "d", "e"]);
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score, "scores decrescentes");
  for (const r of results) {
    const expected = cosineSimilarity(query, vectors[r.chunk_id.split(":")[2]]);
    assert.ok(Math.abs(r.score - expected) < 1e-5, `${r.chunk_id}: ${r.score} vs ${expected}`);
  }
  assert.equal(results[0].section, null);
  assert.equal(results[0].url, "test://test:pt:a:0000");
  await s.close();
});

test("reinserir não duplica (upsert por chunk_id) e atualiza o conteúdo", async () => {
  const s = store("upsert");
  const batch = [chunk("test:pt:1:0000", [1, 0, 0, 0]), chunk("test:pt:2:0000", [0, 1, 0, 0])];
  await s.insertChunks(batch);
  await s.insertChunks(batch);
  assert.equal(await s.count(), 2);
  await s.insertChunks([chunk("test:pt:1:0000", [1, 0, 0, 0], { text: "novo" }), chunk("test:pt:1:0000", [1, 0, 0, 0], { text: "último" })]);
  assert.equal(await s.count(), 2, "id repetido no mesmo lote também não duplica");
  const [top] = await s.search([1, 0, 0, 0], 1);
  assert.equal(top.text, "último");
  await s.close();
});

test("persistência: fechar e reabrir mantém os dados", async () => {
  const a = store("persiste");
  await a.insertChunks([chunk("test:pt:x:0000", [0, 0, 1, 0], { section: "Vida" })]);
  await a.close();
  const b = store("persiste");
  assert.equal(await b.count(), 1);
  const [r] = await b.search([0, 0, 1, 0], 1);
  assert.equal(r.section, "Vida");
  const info = await b.getInfo();
  assert.equal(info.rows, 1);
  assert.ok(info.sizeOnDiskBytes > 0);
  assert.equal(info.indexed, false);
  assert.match(info.engine, /lancedb/);
  await b.close();
});

test("dimensão errada → erro claro", async () => {
  const s = store("dims");
  await assert.rejects(s.insertChunks([chunk("test:pt:x:0000", [1, 0, 0])]), new RegExp(VECTOR_DIMENSION_MISMATCH));
  await assert.rejects(s.search([1, 0], 3), new RegExp(VECTOR_DIMENSION_MISMATCH));
  await s.close();
});

test("filtros e deleteBy com valores escapados (aspas não viram SQL)", async () => {
  const s = store("filtros");
  const evil = "x' OR '1'='1";
  await s.insertChunks([
    chunk("test:pt:1:0000", [1, 0, 0, 0]),
    chunk("test:en:2:0000", [1, 0, 0, 0], { language: "en" }),
    chunk("wikipedia:pt:3:0000", [1, 0, 0, 0], { source: "wikipedia", dataset_version: "20231101" }),
    chunk("odd:pt:4:0000", [1, 0, 0, 0], { source: evil }),
  ]);
  assert.equal(await s.count({ source: "test" }), 2);
  assert.equal(await s.count({ source: evil }), 1, "o valor com aspas é só dado");
  assert.deepEqual((await s.search([1, 0, 0, 0], 10, { language: "en" })).map((r) => r.chunk_id), ["test:en:2:0000"]);
  await s.deleteBy({ source: evil });
  assert.equal(await s.count(), 3, "apagou só a linha com a fonte esquisita");
  await s.deleteBy({ source: "test", language: "pt" });
  assert.equal(await s.count({ source: "test" }), 1);
  await s.deleteBy({ source: "wikipedia", dataset_version: "outro" });
  assert.equal(await s.count({ source: "wikipedia" }), 1, "versão diferente não apaga");
  assert.equal(buildPredicate({ source: "a'b" }), "source = 'a''b'");
  assert.throws(() => buildPredicate({ ["x; DROP" as "source"]: "y" }), /desconhecida/);
  await s.close();
});

test("modelo de embedding diferente → EMBEDDING_MODEL_MISMATCH na busca e na inserção", async () => {
  const a = store("modelo");
  await a.insertChunks([chunk("test:pt:1:0000", [1, 0, 0, 0])]);
  await a.close();
  const b = store("modelo", { model: "outro-modelo" });
  await assert.rejects(b.search([1, 0, 0, 0], 1), new RegExp(EMBEDDING_MODEL_MISMATCH));
  await assert.rejects(b.insertChunks([chunk("test:pt:2:0000", [1, 0, 0, 0])]), new RegExp(EMBEDDING_MODEL_MISMATCH));
  assert.equal((await b.getInfo()).embeddingModel, MODEL, "info mostra o modelo da base");
  await b.close();
});

test("índice IVF-PQ só acima do limiar; busca continua correta com índice", async () => {
  const dims = 32;
  const s = store("indice", { dims, indexMinRows: 600 });
  // Pseudoaleatório determinístico.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const rows = Array.from({ length: 599 }, (_, i) => chunk(`test:pt:${i}:0000`, Array.from({ length: dims }, rand)));
  await s.insertChunks(rows);
  await s.createIndexIfNeeded();
  assert.equal((await s.getInfo()).indexed, false, "abaixo do limiar: sem índice");
  const target = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
  await s.insertChunks([chunk("test:pt:alvo:0000", target)]);
  await s.createIndexIfNeeded();
  assert.equal((await s.getInfo()).indexed, true);
  const [top] = await s.search(target, 1);
  assert.equal(top.chunk_id, "test:pt:alvo:0000");
  await s.close();
});
