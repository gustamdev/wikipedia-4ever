// Mesmo worker do app, mas como processo filho do Node (`child_process.fork`): usado por
// scripts/ingest-e2e.ts para exercitar o pipeline real sem abrir a janela do Electron.
import type { MainToWorker } from "../../shared/ingestion.ts";
import { runWorker } from "./worker-core.ts";

if (!process.send) throw new Error("worker-node.ts deve ser iniciado com child_process.fork.");
const send = process.send.bind(process);

runWorker({
  post: (message) => void send(message),
  onMessage: (handler) => process.on("message", (message) => handler(message as MainToWorker)),
});
