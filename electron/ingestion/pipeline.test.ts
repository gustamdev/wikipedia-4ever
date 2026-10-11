// Pipeline de ingestão com dependências falsas: o que importa aqui é a lógica de lotes, commits,
// cancelamento e retomada, não o Parquet nem o modelo.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChunkWithVector } from "../../shared/chunk";
import type { IngestionProgress } from "../../shared/ingestion";
import { chunkArticle, DEFAULT_CHUNKER_OPTIONS, dropSectionsFor } from "./chunker.ts";
import type { DatasetFile } from "./hf-datasets";
import type { WikiArticle } from "./parquet-reader";
import { embeddingInput, IngestionPipeline, type PipelineDeps, type PipelineStore } from "./pipeline.ts";
import { IngestionStateStore } from "./state.ts";

const FILES: DatasetFile[] = [
  { name: "train-00000-of-00002.parquet", url: "https://example.test/a", size: 10, sha256: "a" },
  { name: "train-00001-of-00002.parquet", url: "https://example.test/b", size: 20, sha256: "b" },
];
const ARTICLES_PER_FILE = [37, 23];

function article(file: number, index: number): WikiArticle {
  const id = `${file}${String(index).padStart(3, "0")}`;
  const paragraph = (n: number) => `Este é o parágrafo ${n} do artigo ${id}. `.repeat(12).trim();
  // Alguns artigos têm seção, outros não; um tem texto vazio (zero chunks).
  const text = index === 5 ? "" : `${paragraph(1)}\n\nHistória\n\n${paragraph(2)}\n\n${paragraph(3)}`;
  return { id, url: `https://pt.wikipedia.org/wiki?curid=${id}`, title: `Artigo ${id}`, text };
}

function fakeReader(): NonNullable<PipelineDeps["reader"]> {
  const fileIndex = (file: string) => FILES.findIndex((f) => file.endsWith(f.name));
  return {
    countRows: async (file) => ARTICLES_PER_FILE[fileIndex(file)],
    sampleArticles: async () => [],
    async *readArticles(file, opts = {}) {
      const f = fileIndex(file);
      const batchSize = opts.batchSize ?? 64;
      let batch: WikiArticle[] = [];
      for (let i = opts.skip ?? 0; i < ARTICLES_PER_FILE[f]; i++) {
        batch.push(article(f, i));
        if (batch.length === batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length) yield batch;
    },
  };
}

function expectedChunkIds(): string[] {
  const options = { ...DEFAULT_CHUNKER_OPTIONS, dropSections: dropSectionsFor("pt", []) };
  const ids: string[] = [];
  ARTICLES_PER_FILE.forEach((count, f) => {
    for (let i = 0; i < count; i++) {
      for (const c of chunkArticle(article(f, i), { language: "pt", source: "wikipedia", dataset_version: "20231101" }, options)) ids.push(c.chunk_id);
    }
  });
  return ids;
}

/** Store em memória com a mesma semântica de upsert por `chunk_id`. */
function fakeStore() {
  const rows = new Map<string, ChunkWithVector>();
  const calls = { inserts: 0, optimize: 0, index: 0, deletes: 0 };
  const store: PipelineStore = {
    async insertChunks(chunks) {
      calls.inserts++;
      for (const c of chunks) rows.set(c.chunk_id, c);
    },
    async deleteBy(filter) {
      calls.deletes++;
      for (const [id, row] of rows) if (row.language === filter.language && row.dataset_version === filter.dataset_version) rows.delete(id);
    },
    async optimize() {
      calls.optimize++;
    },
    async createIndexIfNeeded() {
      calls.index++;
    },
    async getInfo() {
      return { rows: rows.size, sizeOnDiskBytes: 1234, embeddingModel: "fake", dimensions: 4, indexed: false, engine: "fake" };
    },
  };
  return { store, rows, calls };
}

/** Vetor determinístico a partir do texto: permite conferir que cada vetor voltou ao chunk certo. */
const vectorOf = (text: string) => [text.length, text.charCodeAt(0), text.charCodeAt(text.length - 1), 1];

interface Harness {
  dir: string;
  pipeline: IngestionPipeline;
  rows: Map<string, ChunkWithVector>;
  calls: ReturnType<typeof fakeStore>["calls"];
  progress: IngestionProgress[];
  state: IngestionStateStore;
  downloads: string[];
  embedCalls: number[];
}

async function harness(overrides: Partial<PipelineDeps> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "w4e-pipeline-"));
  const { store, rows, calls } = fakeStore();
  const progress: IngestionProgress[] = [];
  const downloads: string[] = [];
  const embedCalls: number[] = [];
  const state = new IngestionStateStore(path.join(dir, "ingestion-state.json"));
  const deps: PipelineDeps = {
    store,
    state,
    datasetsDir: path.join(dir, "datasets"),
    embed: async (texts) => {
      embedCalls.push(texts.length);
      return texts.map(vectorOf);
    },
    listFiles: async () => FILES,
    downloadFile: async (file, dest, onProgress) => {
      downloads.push(file.name);
      onProgress({ bytes: file.size, total: file.size, bytesPerSecond: 1, verifying: false });
      await writeFile(dest, Buffer.alloc(file.size));
    },
    onProgress: (p) => progress.push(p),
    reader: fakeReader(),
    batchSize: 16,
    commitSize: 64,
    progressIntervalMs: 0,
    ...overrides,
  };
  return { dir, pipeline: new IngestionPipeline(deps), rows, calls, progress, state, downloads, embedCalls };
}

const REQUEST = { language: "pt", snapshot: "20231101" } as const;

test("embeddingInput: título — seção: texto (e só o título sem seção)", () => {
  assert.equal(embeddingInput({ document_title: "Einstein", section: "Vida", text: "Nasceu em Ulm." }), "Einstein — Vida: Nasceu em Ulm.");
  assert.equal(embeddingInput({ document_title: "Einstein", section: null, text: "Foi físico." }), "Einstein: Foi físico.");
  const long = embeddingInput({ document_title: "x".repeat(500), section: null, text: "t" });
  assert.ok(long.length < 200, "o contexto é limitado");
});

test("execução completa: todos os chunks, vetores nos chunks certos, estado limpo, resumo", async (t) => {
  const h = await harness();
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  const outcome = await h.pipeline.run(REQUEST, false, new AbortController().signal);

  assert.equal(outcome.type, "done");
  const expected = expectedChunkIds();
  assert.deepEqual([...h.rows.keys()].sort(), [...expected].sort());
  for (const row of h.rows.values()) {
    assert.deepEqual(row.vector, vectorOf(embeddingInput(row)), "o vetor pertence ao texto deste chunk");
  }
  if (outcome.type === "done") {
    assert.equal(outcome.summary.articles, 60);
    assert.equal(outcome.summary.chunks, expected.length);
    assert.equal(outcome.summary.vectors, expected.length);
  }
  assert.equal(await h.state.load(), null, "estado removido ao concluir");
  assert.equal(h.calls.index, 1);
  assert.ok(h.calls.optimize >= 1);
  assert.deepEqual(h.downloads, FILES.map((f) => f.name));
  // Progresso: baixa, embute, indexa, nessa ordem; artigos nunca regridem.
  const stages = h.progress.map((p) => p.stage);
  assert.equal(stages[0], "download");
  assert.ok(stages.indexOf("embed") > stages.lastIndexOf("download"));
  assert.equal(stages.at(-1), "index");
  const embed = h.progress.filter((p) => p.stage === "embed");
  assert.ok(embed.every((p, i) => i === 0 || p.current >= embed[i - 1].current));
  assert.equal(embed.at(-1)!.current, 60);
  assert.equal(embed.at(-1)!.total, 60);
});

test("embeddingInput: níveis de contexto (título só, nenhum)", () => {
  const chunk = { document_title: "Einstein", section: "Vida", text: "Nasceu em Ulm." };
  assert.equal(embeddingInput(chunk, "title"), "Einstein: Nasceu em Ulm.");
  assert.equal(embeddingInput(chunk, "none"), "Nasceu em Ulm.");
});

test("tokens reais: quem passa do limite com seção no prefixo fica só com o título", async (t) => {
  // O trecho sozinho sempre cabe (sem rechunk); com seção no prefixo, nunca.
  const tokens = (x: string) => (!x.startsWith("Artigo") ? 1 : x.includes(" — ") ? 10_000 : 1);
  const h = await harness({ maxModelTokens: 512, countTokens: async (texts) => texts.map(tokens) });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  const outcome = await h.pipeline.run(REQUEST, false, new AbortController().signal);
  assert.deepEqual([...h.rows.keys()].sort(), [...expectedChunkIds()].sort(), "sem rechunk");
  let shortened = 0;
  for (const row of h.rows.values()) {
    const expected = row.section ? embeddingInput(row, "title") : embeddingInput(row);
    if (row.section) shortened++;
    assert.deepEqual(row.vector, vectorOf(expected), row.chunk_id);
  }
  assert.ok(shortened > 0);
  if (outcome.type === "done") assert.equal(outcome.summary.truncatedChunks, 0);
});

test("nem no menor tamanho de chunk cabe: embute sem contexto e conta como truncado", async (t) => {
  const h = await harness({ maxModelTokens: 512, countTokens: async (texts) => texts.map(() => 10_000) });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  const outcome = await h.pipeline.run(REQUEST, false, new AbortController().signal);
  for (const row of h.rows.values()) assert.deepEqual(row.vector, vectorOf(embeddingInput(row, "none")));
  if (outcome.type === "done") assert.equal(outcome.summary.truncatedChunks, h.rows.size);
});

test("trecho que passa do limite real sem contexto: o artigo é rechunkado menor, sem truncar", async (t) => {
  // "Tokens" = caracteres: chunks de 2 parágrafos (~1.100) passam de 700; 1 parágrafo + overlap cabe.
  const limit = 700;
  const run = async () => {
    const h = await harness({ maxModelTokens: limit, countTokens: async (texts) => texts.map((x) => x.length) });
    t.after(() => rm(h.dir, { recursive: true, force: true }));
    const outcome = await h.pipeline.run(REQUEST, false, new AbortController().signal);
    return { h, outcome };
  };
  const { h, outcome } = await run();
  assert.ok(h.rows.size > expectedChunkIds().length, "mais chunks, menores");
  for (const row of h.rows.values()) assert.ok(row.text.length <= limit, `${row.chunk_id}: ${row.text.length}`);
  if (outcome.type === "done") assert.equal(outcome.summary.truncatedChunks, 0);
  const again = await run();
  assert.deepEqual([...again.h.rows.keys()].sort(), [...h.rows.keys()].sort(), "determinístico");
});

test("sem tokenizer (countTokens devolve null) usa o contexto completo", async (t) => {
  const h = await harness({ countTokens: async () => null, maxModelTokens: 1 });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  const outcome = await h.pipeline.run(REQUEST, false, new AbortController().signal);
  for (const row of h.rows.values()) assert.deepEqual(row.vector, vectorOf(embeddingInput(row)));
  if (outcome.type === "done") assert.equal(outcome.summary.truncatedChunks, 0);
});

test("commits agrupam vários lotes de embedding", async (t) => {
  const h = await harness({ batchSize: 8, commitSize: 100 });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await h.pipeline.run(REQUEST, false, new AbortController().signal);
  assert.ok(h.embedCalls.length > h.calls.inserts * 2, `${h.embedCalls.length} lotes de embedding para ${h.calls.inserts} commits`);
});

test("cancelar no meio grava o parcial; retomar completa sem duplicar", async (t) => {
  const controller = new AbortController();
  let embedded = 0;
  const h = await harness({
    embed: async (texts) => {
      embedded += texts.length;
      if (embedded > 60) controller.abort();
      return texts.map(vectorOf);
    },
  });
  t.after(() => rm(h.dir, { recursive: true, force: true }));

  const first = await h.pipeline.run(REQUEST, false, controller.signal);
  assert.equal(first.type, "canceled");
  const partial = h.rows.size;
  const expected = expectedChunkIds();
  assert.ok(partial > 0 && partial < expected.length, `parcial: ${partial} de ${expected.length}`);
  const saved = await h.state.load();
  assert.ok(saved && saved.chunks === partial, "o estado conta exatamente o que está gravado");
  assert.ok(saved!.articles > 0 && saved!.articles < 60);

  const second = await h.pipeline.run(REQUEST, true, new AbortController().signal);
  assert.equal(second.type, "done");
  assert.equal(h.rows.size, expected.length, "sem duplicatas e sem faltas");
  assert.deepEqual([...h.rows.keys()].sort(), [...expected].sort());
  assert.deepEqual(h.downloads, FILES.map((f) => f.name), "a retomada não baixa de novo");
  assert.equal(h.calls.deletes, 1, "só o início do zero apaga linhas");
});

test("falha no meio (embedding) preserva o confirmado; retomar continua do último commit", async (t) => {
  let embedded = 0;
  let fail = true;
  const h = await harness({
    embed: async (texts) => {
      embedded += texts.length;
      if (fail && embedded > 90) throw new Error("falha simulada");
      return texts.map(vectorOf);
    },
  });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await assert.rejects(h.pipeline.run(REQUEST, false, new AbortController().signal), /falha simulada/);
  const saved = await h.state.load();
  assert.ok(saved && saved.chunks === h.rows.size && saved.chunks > 0, "o estado bate com o banco");

  fail = false;
  const outcome = await h.pipeline.run(REQUEST, true, new AbortController().signal);
  assert.equal(outcome.type, "done");
  assert.deepEqual([...h.rows.keys()].sort(), [...expectedChunkIds()].sort());
});

test("retomar com o último commit gravado mas estado atrasado não duplica", async (t) => {
  // Queda entre o `insertChunks` e o `save`: o estado não conhece o último commit; o upsert absorve.
  const h = await harness();
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  const controller = new AbortController();
  let embedded = 0;
  (h.pipeline as unknown as { deps: PipelineDeps }).deps.embed = async (texts) => {
    embedded += texts.length;
    if (embedded > 80) controller.abort();
    return texts.map(vectorOf);
  };
  await h.pipeline.run(REQUEST, false, controller.signal);
  const saved = (await h.state.load())!;
  const stale = { ...saved, articles: Math.max(0, saved.articles - 10), articlesInFile: Math.max(0, saved.articlesInFile - 10), chunks: 0 };
  await h.state.save(stale);
  const outcome = await h.pipeline.run(REQUEST, true, new AbortController().signal);
  assert.equal(outcome.type, "done");
  assert.deepEqual([...h.rows.keys()].sort(), [...expectedChunkIds()].sort(), "chunk_ids únicos");
});

test("falha no download não apaga nada e deixa o estado para retomar", async (t) => {
  let attempts = 0;
  const h = await harness({
    downloadFile: async (file, dest) => {
      if (file.name === FILES[1].name && attempts++ === 0) throw new Error("sem rede");
      await writeFile(dest, Buffer.alloc(file.size));
    },
  });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await assert.rejects(h.pipeline.run(REQUEST, false, new AbortController().signal), /sem rede/);
  assert.ok(await h.state.load(), "estado salvo antes do download");
  const outcome = await h.pipeline.run(REQUEST, true, new AbortController().signal);
  assert.equal(outcome.type, "done");
  assert.equal(h.rows.size, expectedChunkIds().length);
});

test("deleteRaw apaga os Parquets só depois de concluir", async (t) => {
  const h = await harness();
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await h.pipeline.run({ ...REQUEST, deleteRaw: true }, false, new AbortController().signal);
  await assert.rejects(stat(path.join(h.dir, "datasets", "20231101.pt")), /ENOENT/);
});

test("recomeçar do zero apaga as linhas da base anterior do mesmo idioma", async (t) => {
  const h = await harness();
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await h.pipeline.run(REQUEST, false, new AbortController().signal);
  h.rows.set("stale", { ...[...h.rows.values()][0], chunk_id: "stale" });
  await h.pipeline.run(REQUEST, false, new AbortController().signal);
  assert.ok(!h.rows.has("stale"));
  assert.equal(h.rows.size, expectedChunkIds().length);
});

test("idioma inválido é recusado antes de qualquer trabalho", async (t) => {
  const h = await harness();
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await assert.rejects(h.pipeline.run({ language: "../x", snapshot: "20231101" }, false, new AbortController().signal), /idioma/i);
  assert.equal(h.downloads.length, 0);
});
