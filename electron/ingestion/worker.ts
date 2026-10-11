// Entrada do `utilityProcess` (build extra do Vite → dist-electron/worker.js). O Main o cria com
// `utilityProcess.fork`; a comunicação é só por `parentPort`, com as mensagens de shared/ingestion.ts.
import type { MainToWorker } from "../../shared/ingestion";
import { runWorker } from "./worker-core.ts";

const port = process.parentPort;
if (!port) throw new Error("worker.ts deve rodar como utilityProcess do Electron.");

// Erro não tratado: o Main já recebe `exit` com código diferente de zero e marca a ingestão como interrompida.
process.on("uncaughtException", (error) => {
  console.error("[ingestion-worker] erro fatal:", error);
  process.exit(1);
});

runWorker({
  post: (message) => port.postMessage(message),
  onMessage: (handler) => port.on("message", (event) => handler(event.data as MainToWorker)),
});
