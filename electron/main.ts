import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC } from "../shared/ipc-channels";
import { EmbeddingEngine } from "./embeddings/embedding-engine";
import { registerChatHandlers, shutdownChat } from "./ipc/chat";
import { registerEmbeddingHandlers } from "./ipc/embeddings";
import { registerIngestionHandlers } from "./ipc/ingestion";
import type { IngestionController } from "./ingestion/controller";
import { registerVectorHandlers } from "./ipc/vector";
import { cancelAllGenerations, registerLlmHandlers } from "./ipc/llm";
import { registerModelHandlers } from "./ipc/models";
import { registerSystemHandlers } from "./ipc/system";
import { LlmRuntime } from "./llm/runtime";
import { ModelManager } from "./models/model-manager";
import { RagEngine } from "./rag/rag-engine";
import { LanceVectorStore } from "./vector/vector-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

let mainWindow: BrowserWindow | null = null;
let manager: ModelManager | null = null;
let embeddings: EmbeddingEngine | null = null;
let vectors: LanceVectorStore | null = null;
let ingestion: IngestionController | null = null;

const EXTERNAL_HOSTS = new Set(["huggingface.co"]);

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer encerrado:", details.reason, details.exitCode);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Nenhuma janela nem navegação a partir do conteúdo renderizado. Links de licença (https em
  // hosts conhecidos) abrem no navegador do sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

/** Teto para a limpeza: passou disso, o processo sai mesmo assim (nunca fica pendurado). */
const SHUTDOWN_TIMEOUT_MS = 8000;

/** Interrompe tudo que roda no Main e termina o processo (`app.exit`, sem reentrar no `before-quit`). */
async function shutdown(): Promise<void> {
  const started = Date.now();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  const cleanup = (async () => {
    // Ordem: o chat grava o parcial e fecha o banco antes de o runtime ser liberado.
    cancelAllGenerations();
    await shutdownChat();
    // Instalação de embeddings em andamento é abandonada (sem marcador, recomeça do zero na próxima vez).
    // A ingestão para primeiro: o worker grava o parcial e sai antes de o app encerrar (nada fica em segundo plano).
    await ingestion?.shutdown();
    await Promise.all([manager?.shutdown(), embeddings?.dispose(), vectors?.close()]);
  })().catch((error) => console.error("Falha ao encerrar:", error));
  const timedOut = await Promise.race([
    cleanup.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS).unref()),
  ]);
  console.info(
    timedOut
      ? `[app] limpeza excedeu ${SHUTDOWN_TIMEOUT_MS} ms; saindo assim mesmo`
      : `[app] encerrado em ${Date.now() - started} ms`,
  );
  app.exit(0);
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

/** Override de dev do modelo (Semana 1); ignorado no app empacotado. */
function devModelPath(): string | null {
  const fromEnv = process.env.W4E_DEV_MODEL;
  return fromEnv && !app.isPackaged ? path.resolve(fromEnv) : null;
}

// Erro não tratado no Main deixa o app num estado indefinido: encerra em vez de ficar vivo sem janela.
process.on("uncaughtException", (error) => {
  console.error("Erro fatal no processo principal:", error);
  app.exit(1);
});

// Uma instância só: duas instâncias compartilhariam userData (config.json e os `.part` dos downloads).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Regra do projeto: fechar a janela ENCERRA o app em todos os SOs (inclusive macOS, contrariando o
  // padrão de ficar no Dock). Nada continua em segundo plano: downloads param (o `.part` fica no
  // disco), gerações são abortadas e o modelo sai da RAM.
  app.on("window-all-closed", () => app.quit());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void shutdown();
  });

  ipcMain.handle(IPC.ping, () => "pong");

  app.whenReady().then(() => {
    const dataDir = app.getPath("userData");
    manager = new ModelManager({
      dataDir,
      runtime: new LlmRuntime(),
      devModelPath: devModelPath(),
      onDownloadProgress: (progress) => broadcast(IPC.downloadProgress, progress),
      onActiveChanged: (active) => broadcast(IPC.modelsActiveChanged, active),
      onModelsChanged: () => broadcast(IPC.modelsChanged, null),
    });
    const ready = manager.init();
    ready.then(
      () => manager?.startDefaultLoad(),
      (error) => console.error("Falha ao inicializar os modelos:", error),
    );
    registerModelHandlers(manager, ready);
    registerLlmHandlers(manager);
    embeddings = new EmbeddingEngine({ cacheDir: path.join(dataDir, "embedding-models") });
    registerEmbeddingHandlers(embeddings);
    // Aberto sob demanda (primeira chamada): não pesa na abertura do app.
    vectors = new LanceVectorStore({
      dir: path.join(dataDir, "vectordb"),
      embeddingModel: embeddings.modelId,
      dimensions: embeddings.dimensions,
    });
    const embedder = embeddings;
    const store = vectors;
    const models = manager;
    const rag = new RagEngine({
      embedQuery: async (text) => (await embedder.embed([text], "query"))[0],
      // Só a Wikipedia: os dados de teste da tela de Desenvolvedor ficam de fora.
      search: (vector, topK) => store.search(vector, topK, { source: "wikipedia" }),
      countPromptTokens: (messages) => models.countPromptTokens(messages),
      countTextTokens: (text) => models.countTextTokens(text),
      contextSize: () => models.contextSize(),
      generate: (options) => models.generate(options),
      locale: () => app.getLocale(),
    });
    registerChatHandlers(manager, {
      engine: rag,
      knowledgeInstalled: () => models.config.get().knowledgeBases.some((kb) => kb.chunks > 0),
    });
    registerVectorHandlers(vectors, embeddings, () => ingestion?.isRunning() ?? false);
    ingestion = registerIngestionHandlers({
      dataDir,
      distDir: __dirname,
      config: manager.config,
      ready,
      embeddingModel: embeddings.modelId,
    });
    registerSystemHandlers(dataDir);
    // A janela abre já; o carregamento do modelo padrão segue em background.
    createWindow();
  });
}
