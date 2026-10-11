// IngestionController com worker falso: estados vistos pela UI, bloqueio por espaço, registro da
// base em config.json e encerramento. O worker real é exercitado por scripts/ingest-e2e.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IngestionSummary, MainToWorker, WorkerToMain } from "../../shared/ingestion";
import { ConfigStore } from "../config/config-store.ts";
import { IngestionController, type WorkerHandle } from "./controller.ts";
import type { DatasetFile } from "./hf-datasets";
import { IngestionStateStore } from "./state.ts";

const FILES: DatasetFile[] = [{ name: "train-00000-of-00001.parquet", url: "https://example.test/a", size: 150_000_000, sha256: "a" }];

class FakeWorker implements WorkerHandle {
  readonly received: MainToWorker[] = [];
  killed = false;
  private messageHandler: (message: WorkerToMain) => void = () => undefined;
  private exitHandler: (code: number | null) => void = () => undefined;
  postMessage(message: MainToWorker): void {
    this.received.push(message);
  }
  onMessage(handler: (message: WorkerToMain) => void): void {
    this.messageHandler = handler;
  }
  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }
  kill(): void {
    this.killed = true;
  }
  send(message: WorkerToMain): void {
    this.messageHandler(message);
  }
  exit(code: number | null): void {
    this.exitHandler(code);
  }
}

async function setup(freeBytes = 1e12) {
  const dir = await mkdtemp(path.join(tmpdir(), "w4e controller-"));
  const config = new ConfigStore(dir);
  await config.load();
  const workers: FakeWorker[] = [];
  const controller = new IngestionController({
    paths: {
      datasetsDir: path.join(dir, "datasets"),
      stateFile: path.join(dir, "ingestion-state.json"),
      vectorDir: path.join(dir, "vectordb"),
      embeddingCacheDir: path.join(dir, "embedding-models"),
    },
    config,
    embeddingModel: "fake-e5",
    fork: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onProgress: () => undefined,
    onStatusChanged: () => undefined,
    listFiles: async () => FILES,
    listLanguages: async () => [{ code: "simple", snapshot: "20231101" }],
    freeBytes: async () => freeBytes,
  });
  await controller.init();
  // Espera as gravações de config.json em andamento (o `update` vazio entra na fila delas) antes de apagar.
  const cleanup = async () => {
    await config.update(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, config, controller, workers, cleanup };
}

/** O registro da base em config.json é assíncrono (não bloqueia o aviso à UI). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate(), "condição não ocorreu a tempo");
}

const SUMMARY: IngestionSummary = {
  language: "simple",
  snapshot: "20231101",
  articles: 10,
  chunks: 25,
  truncatedChunks: 0,
  vectors: 25,
  sizeOnDiskBytes: 4096,
  elapsedMs: 1000,
  chunksPerSecond: 25,
};

test("espaço insuficiente bloqueia o início: nenhum worker é criado", async (t) => {
  const h = await setup(1_000);
  t.after(h.cleanup);
  const estimate = await h.controller.estimate("simple");
  assert.equal(estimate.sufficient, false);
  await assert.rejects(h.controller.start({ language: "simple" }), /Espaço insuficiente/);
  assert.equal(h.workers.length, 0);
  assert.equal(h.controller.status().state, "idle");
});

test("início → progresso → concluída: status, resumo e base completa em config.json", async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.controller.start({ language: "simple" });
  const [worker] = h.workers;
  assert.equal(h.controller.status().state, "running");
  assert.equal(h.controller.isRunning(), true, "escritas de fora do worker ficam bloqueadas");
  assert.deepEqual(worker.received[0], {
    type: "start",
    request: { language: "simple", snapshot: "20231101" },
    paths: (worker.received[0] as Extract<MainToWorker, { type: "start" }>).paths,
    batchSize: undefined,
    resume: false,
  });
  await assert.rejects(h.controller.start({ language: "simple" }), /em andamento/, "uma ingestão por vez");

  const progress = { stage: "embed", current: 5, total: 10, unit: "articles", articles: 5, chunks: 12, elapsedMs: 500, etaSeconds: 1 } as const;
  worker.send({ type: "progress", progress });
  assert.deepEqual(h.controller.status().progress, progress);

  worker.send({ type: "done", summary: SUMMARY });
  const status = h.controller.status();
  assert.equal(status.state, "completed");
  assert.deepEqual(status.summary, SUMMARY);
  assert.equal(status.resumable, false);
  assert.ok(worker.killed, "o processo do worker é encerrado ao fim");
  assert.equal(h.controller.isRunning(), false);
  await waitFor(() => h.config.get().knowledgeBases.length === 1);
  const [base] = h.config.get().knowledgeBases;
  assert.equal(base.id, "wikipedia-simple");
  assert.equal(base.status, "complete");
  assert.equal(base.chunks, 25);
  assert.equal(base.embeddingModel, "fake-e5");
});

test("cancelar: pede ao worker, fica parcial e retomável; retomar manda resume=true", async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.controller.start({ language: "simple" });
  h.controller.cancel();
  assert.equal(h.controller.status().state, "canceling");
  assert.deepEqual(h.workers[0].received.at(-1), { type: "cancel" });

  // O worker grava o estado antes de avisar (é o que "Retomar" lê).
  const state = new IngestionStateStore(path.join(h.dir, "ingestion-state.json"));
  await state.save({
    version: 1,
    language: "simple",
    snapshot: "20231101",
    deleteRaw: false,
    files: FILES,
    learnedAppendices: [],
    fileArticleCounts: [10],
    fileIndex: 0,
    articlesInFile: 4,
    articles: 4,
    chunks: 9,
    workMs: 400,
    phase: "embed",
    startedAt: new Date().toISOString(),
    updatedAt: "",
  });
  h.workers[0].send({ type: "canceled", articles: 4, chunks: 9 });
  assert.equal(h.controller.status().state, "partial");
  assert.equal(h.controller.status().resumable, true);
  await waitFor(() => h.config.get().knowledgeBases[0]?.status === "partial");
  assert.equal(h.config.get().knowledgeBases[0].chunks, 9);

  await h.controller.resume();
  const start = h.workers[1].received[0] as Extract<MainToWorker, { type: "start" }>;
  assert.equal(start.resume, true);
  assert.equal(start.request.language, "simple");

  // Um app aberto depois do fechamento enxerga a ingestão interrompida.
  const other = new IngestionController({
    paths: { datasetsDir: path.join(h.dir, "datasets"), stateFile: state.filePath, vectorDir: path.join(h.dir, "vectordb"), embeddingCacheDir: "" },
    config: h.config,
    embeddingModel: "fake-e5",
    fork: () => new FakeWorker(),
    onProgress: () => undefined,
    onStatusChanged: () => undefined,
  });
  await other.init();
  assert.equal(other.status().state, "partial");
  assert.equal(other.status().resumable, true);
});

test("worker que morre sem avisar vira erro; fechar o app vira parcial", async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.controller.start({ language: "simple" });
  h.workers[0].exit(1);
  await waitFor(() => h.controller.status().state === "error");
  await waitFor(() => h.config.get().knowledgeBases[0]?.status === "partial");
  assert.match(h.controller.status().error ?? "", /terminou inesperadamente/);

  await h.controller.start({ language: "simple" });
  const closing = h.controller.shutdown();
  assert.deepEqual(h.workers[1].received.at(-1), { type: "cancel" });
  h.workers[1].exit(0);
  await closing;
  assert.equal(h.controller.status().state, "partial");
  assert.equal(h.controller.status().error, null);
  // `shutdown` só resolve depois de a base parcial estar em config.json (o app sai logo em seguida).
  const onDisk = new ConfigStore(h.dir);
  assert.equal((await onDisk.load()).knowledgeBases[0]?.status, "partial");
});
