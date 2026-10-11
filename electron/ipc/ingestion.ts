import { BrowserWindow, ipcMain, utilityProcess } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { DEFAULT_SNAPSHOT, type MainToWorker, type WorkerToMain } from "../../shared/ingestion";
import type { ConfigStore } from "../config/config-store";
import { IngestionController, type WorkerHandle } from "../ingestion/controller";
import { assertDatasetId } from "../ingestion/hf-datasets";

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

/** Worker de ingestão: entrada extra do build (dist-electron/worker.js), num processo separado. */
function forkWorker(distDir: string): WorkerHandle {
  const child = utilityProcess.fork(path.join(distDir, "worker.js"), [], { serviceName: "wikipedia4ever-ingestion" });
  return {
    postMessage: (message: MainToWorker) => child.postMessage(message),
    onMessage: (handler) => child.on("message", (message: WorkerToMain) => handler(message)),
    onExit: (handler) => child.on("exit", (code) => handler(code)),
    kill: () => void child.kill(),
  };
}

export interface IngestionIpcOptions {
  dataDir: string;
  /** Pasta do build do Main (onde está `worker.js`). */
  distDir: string;
  config: ConfigStore;
  /** Resolve quando `config.json` já foi lido. */
  ready: Promise<void>;
  embeddingModel: string;
}

export function registerIngestionHandlers(options: IngestionIpcOptions): IngestionController {
  const { dataDir, config } = options;
  const controller = new IngestionController({
    paths: {
      datasetsDir: path.join(dataDir, "datasets"),
      stateFile: path.join(dataDir, "ingestion-state.json"),
      vectorDir: path.join(dataDir, "vectordb"),
      embeddingCacheDir: path.join(dataDir, "embedding-models"),
    },
    config,
    embeddingModel: options.embeddingModel,
    fork: () => forkWorker(options.distDir),
    onProgress: (progress) => broadcast(IPC.ingestionProgress, progress),
    onStatusChanged: () => broadcast(IPC.ingestionStatusChanged, null),
  });
  // Os handlers já existem na abertura; cada um espera a leitura do estado salvo.
  const initialized = options.ready.then(() => controller.init());

  /** `{ language }` do Renderer: só o formato de código de idioma passa (vira URL e caminho de disco). */
  const language = (payload: unknown): string => {
    const value = (payload as { language?: unknown } | null)?.language;
    if (typeof value !== "string") throw new Error("Idioma inválido.");
    assertDatasetId(value, DEFAULT_SNAPSHOT);
    return value;
  };

  ipcMain.handle(IPC.ingestionLanguages, () => controller.languages());
  ipcMain.handle(IPC.ingestionEstimate, async (_event, payload: unknown) => {
    await initialized;
    return controller.estimate(language(payload));
  });
  ipcMain.handle(IPC.ingestionStart, async (_event, payload: unknown) => {
    await initialized;
    const lang = language(payload);
    const deleteRaw = (payload as { deleteRaw?: unknown }).deleteRaw === true;
    console.info(`[ingestion] iniciar ${lang}${deleteRaw ? " (apagar bruto ao fim)" : ""}`);
    await controller.start({ language: lang, deleteRaw });
  });
  ipcMain.handle(IPC.ingestionCancel, () => {
    console.info("[ingestion] cancelar");
    controller.cancel();
  });
  ipcMain.handle(IPC.ingestionResume, async () => {
    await initialized;
    console.info("[ingestion] retomar");
    await controller.resume();
  });
  ipcMain.handle(IPC.ingestionStatus, async () => {
    await initialized;
    return controller.status();
  });
  ipcMain.handle(IPC.ingestionKnowledgeBases, async () => {
    await options.ready;
    return config.get().knowledgeBases;
  });
  return controller;
}
