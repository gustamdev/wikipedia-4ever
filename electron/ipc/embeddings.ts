import { BrowserWindow, ipcMain } from "electron";
import type { EmbeddingInstallProgress } from "../../shared/embeddings";
import { IPC } from "../../shared/ipc-channels";
import { cosineSimilarity } from "../../shared/vector-math";
import type { EmbeddingEngine } from "../embeddings/embedding-engine";

const MAX_TEXT_CHARS = 8000;
/** Throttle do progresso (README → Não bloquear a UI). */
const PROGRESS_INTERVAL_MS = 200;

function assertText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_CHARS) throw new Error(`${name} vazio ou longo demais.`);
  return value;
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function registerEmbeddingHandlers(engine: EmbeddingEngine): void {
  ipcMain.handle(IPC.embeddingsStatus, () => engine.status());

  ipcMain.handle(IPC.embeddingsInstall, async () => {
    console.info(`[embeddings] instalar ${engine.modelId} (${engine.dtype})`);
    let lastSent = 0;
    let lastFile = "";
    await engine.install((progress: EmbeddingInstallProgress) => {
      const now = Date.now();
      const finished = progress.total > 0 && progress.loaded >= progress.total;
      // Sempre envia troca de arquivo e fim de arquivo; o resto, no máximo a cada 200 ms.
      if (progress.file === lastFile && !finished && now - lastSent < PROGRESS_INTERVAL_MS) return;
      lastSent = now;
      lastFile = progress.file;
      broadcast(IPC.embeddingsInstallProgress, progress);
    });
    console.info(`[embeddings] instalado em ${engine.modelDir}`);
  });

  ipcMain.handle(IPC.embeddingsSimilarity, async (_event, payload: unknown) => {
    const p = payload as { a?: unknown; b?: unknown } | null;
    const a = assertText(p?.a, "a");
    const b = assertText(p?.b, "b");
    const started = performance.now();
    const [va, vb] = await engine.embed([a, b], "passage");
    return { score: cosineSimilarity(va, vb), ms: Math.round(performance.now() - started) };
  });
}
