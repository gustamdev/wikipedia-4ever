import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { findCatalogModel } from "../models/catalog";
import type { ModelManager } from "../models/model-manager";

/** Valida `{ id }` vindo do Renderer contra o catálogo. */
function assertModelId(payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !findCatalogModel(id)) throw new Error("Modelo desconhecido.");
  return id;
}

/** `ready` resolve quando o ModelManager terminou de reconciliar config e disco. */
export function registerModelHandlers(manager: ModelManager, ready: Promise<void>): void {
  const handle = (channel: string, action: string, fn: (id: string) => unknown) =>
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      const id = assertModelId(payload);
      await ready;
      console.info(`[models] ${action} ${id}`);
      await fn(id);
    });

  ipcMain.handle(IPC.modelsList, async () => {
    await ready;
    return manager.list();
  });
  ipcMain.handle(IPC.modelsActive, () => manager.active());

  handle(IPC.modelsInstall, "install", (id) => manager.install(id));
  handle(IPC.modelsPause, "pause", (id) => manager.pause(id));
  handle(IPC.modelsResume, "resume", (id) => manager.resume(id));
  handle(IPC.modelsCancel, "cancel", (id) => manager.cancel(id));
  handle(IPC.modelsRemove, "remove", (id) => manager.remove(id));
  handle(IPC.modelsSetDefault, "setDefault", (id) => manager.setDefault(id));
  handle(IPC.modelsLoad, "load", (id) => manager.load(id));
}
