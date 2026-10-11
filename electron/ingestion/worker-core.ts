// Corpo do worker de ingestão, sem depender de como as mensagens trafegam: no app roda num
// `utilityProcess` (worker.ts); nos testes, num processo filho do Node. Uma ingestão por processo.
import type { MainToWorker, WorkerStartMessage, WorkerToMain } from "../../shared/ingestion";
import { E5_MAX_TOKENS, EmbeddingEngine } from "../embeddings/embedding-engine.ts";
import { LanceVectorStore } from "../vector/vector-store.ts";
import { createDatasetDownloader } from "./dataset-downloader.ts";
import { listDatasetFiles } from "./hf-datasets.ts";
import { IngestionPipeline } from "./pipeline.ts";
import { IngestionStateStore } from "./state.ts";

export interface WorkerChannel {
  post(message: WorkerToMain): void;
  onMessage(handler: (message: MainToWorker) => void): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runWorker(channel: WorkerChannel): void {
  let started = false;
  const controller = new AbortController();

  channel.onMessage((message) => {
    if (message.type === "cancel") {
      controller.abort();
    } else if (message.type === "start" && !started) {
      started = true;
      void execute(message, channel, controller.signal);
    }
  });
}

async function execute(message: WorkerStartMessage, channel: WorkerChannel, signal: AbortSignal): Promise<void> {
  const { request, paths } = message;
  const state = new IngestionStateStore(paths.stateFile);
  const downloader = createDatasetDownloader();
  const engine = new EmbeddingEngine({ cacheDir: paths.embeddingCacheDir, batchSize: message.batchSize });
  const store = new LanceVectorStore({ dir: paths.vectorDir, embeddingModel: engine.modelId, dimensions: engine.dimensions });
  try {
    if (!(await engine.isInstalled())) {
      throw new Error("O modelo de embeddings não está instalado. Instale-o em Configurações antes de indexar.");
    }
    await store.open();
    const pipeline = new IngestionPipeline({
      store,
      embed: (texts) => engine.embed(texts, "passage"),
      countTokens: (texts) => engine.countTokens(texts, "passage"),
      maxModelTokens: E5_MAX_TOKENS,
      state,
      datasetsDir: paths.datasetsDir,
      listFiles: (language, snapshot) => listDatasetFiles(language, snapshot),
      downloadFile: downloader.downloadFile,
      onProgress: (progress) => channel.post({ type: "progress", progress }),
      batchSize: message.batchSize,
    });
    const outcome = await pipeline.run(request, message.resume, signal);
    await cleanup();
    channel.post(outcome.type === "done" ? { type: "done", summary: outcome.summary } : outcome);
  } catch (error) {
    const saved = await state.load();
    await cleanup();
    channel.post({ type: "error", message: errorMessage(error), articles: saved?.articles ?? 0, chunks: saved?.chunks ?? 0 });
  }

  async function cleanup(): Promise<void> {
    await Promise.allSettled([downloader.shutdown(), engine.dispose(), store.close()]);
  }
}
