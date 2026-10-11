// Ingestão real de ponta a ponta fora do Electron: IngestionController + worker (processo filho do
// Node) + pipeline + LanceDB, contra o Hugging Face e o modelo e5 de verdade.
//
//   node scripts/ingest-e2e.ts --data <userData falso> --embed-cache <cache do e5> --language simple \
//        [--stop-after <artigos>] [--resume] [--batch 64]
//
// `--stop-after N` cancela (pelo caminho normal de cancelamento) quando N artigos foram indexados;
// sem ele, vai até o fim. Enquanto roda, este processo faz buscas no mesmo banco (leitura concorrente).
import { fork } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigStore } from "../electron/config/config-store.ts";
import { IngestionController, type WorkerHandle } from "../electron/ingestion/controller.ts";
import { E5_DIMENSIONS, E5_MODEL_ID } from "../electron/embeddings/embedding-engine.ts";
import { LanceVectorStore } from "../electron/vector/vector-store.ts";
import type { IngestionProgress, MainToWorker, WorkerToMain } from "../shared/ingestion.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "embed-cache": { type: "string" },
    language: { type: "string", default: "simple" },
    "stop-after": { type: "string" },
    resume: { type: "boolean", default: false },
    batch: { type: "string", default: "64" },
  },
});
if (!values.data || !values["embed-cache"]) {
  console.error("uso: node scripts/ingest-e2e.ts --data <dir> --embed-cache <dir> [--language simple] [--stop-after N] [--resume] [--batch 64]");
  process.exit(1);
}
const dataDir = path.resolve(values.data);
const stopAfter = values["stop-after"] ? Number(values["stop-after"]) : Infinity;
const workerPath = path.join(import.meta.dirname, "..", "electron", "ingestion", "worker-node.ts");

function forkWorker(): WorkerHandle {
  const child = fork(workerPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  return {
    postMessage: (message: MainToWorker) => void child.send(message),
    onMessage: (handler) => child.on("message", (message) => handler(message as WorkerToMain)),
    onExit: (handler) => child.on("exit", (code) => handler(code)),
    kill: () => void child.kill(),
  };
}

const config = new ConfigStore(dataDir);
await config.load();
const paths = {
  datasetsDir: path.join(dataDir, "datasets"),
  stateFile: path.join(dataDir, "ingestion-state.json"),
  vectorDir: path.join(dataDir, "vectordb"),
  embeddingCacheDir: path.resolve(values["embed-cache"]),
};

let controller!: IngestionController;
let last: IngestionProgress | null = null;
let lastPrint = 0;
let canceled = false;
const finished = new Promise<void>((resolve) => {
  controller = new IngestionController({
    paths,
    config,
    embeddingModel: E5_MODEL_ID,
    batchSize: Number(values.batch),
    fork: forkWorker,
    onProgress: (p) => {
      last = p;
      if (Date.now() - lastPrint > 5000 || p.stage === "index") {
        lastPrint = Date.now();
        const rate = p.elapsedMs > 0 ? ((p.chunks / p.elapsedMs) * 1000).toFixed(1) : "-";
        console.log(`[${p.stage}] ${p.current}/${p.total} ${p.unit} · ${p.articles} artigos · ${p.chunks} chunks · ${rate} chunks/s (acumulado) · ETA ${p.etaSeconds ?? "?"} s`);
      }
      if (p.stage === "embed" && p.articles >= stopAfter && !canceled) {
        canceled = true;
        console.log(`>> cancelando em ${p.articles} artigos`);
        controller.cancel();
      }
    },
    onStatusChanged: () => {
      const s = controller.status();
      console.log(`[status] ${s.state}${s.error ? ` · ${s.error}` : ""}`);
      if (s.state !== "running" && s.state !== "canceling") resolve();
    },
  });
});

await controller.init();
console.log("estimativa:", JSON.stringify(await controller.estimate(values.language!)));
if (values.resume) await controller.resume();
else await controller.start({ language: values.language! });

// Leitura concorrente: busca no mesmo banco enquanto o worker escreve.
const reader = new LanceVectorStore({ dir: paths.vectorDir, embeddingModel: E5_MODEL_ID, dimensions: E5_DIMENSIONS });
const probe = Array.from({ length: E5_DIMENSIONS }, () => 0.05);
const counts: number[] = [];
let searchErrors = 0;
const poll = setInterval(async () => {
  try {
    counts.push(await reader.count());
    await reader.search(probe, 3);
  } catch (error) {
    searchErrors++;
    console.error("busca concorrente falhou:", (error as Error).message);
  }
}, 4000);

await finished;
clearInterval(poll);
// Mesmo caminho do fechamento do app: espera o registro da base em config.json antes de sair.
await controller.shutdown();
const status = controller.status();
const info = await reader.getInfo();
console.log("contagens vistas pelo leitor durante a ingestão:", counts.join(", "));
console.log(`buscas concorrentes com erro: ${searchErrors}`);
console.log("status final:", JSON.stringify({ ...status, progress: undefined }));
console.log("banco:", JSON.stringify(info));
// Lido do disco (não da memória): confirma que a gravação terminou.
console.log("bases em config.json (disco):", JSON.stringify((await new ConfigStore(dataDir).load()).knowledgeBases));
console.log("último progresso:", JSON.stringify(last));
await reader.close();
process.exit(0);
