import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { detectHardware } from "../system/hardware";

export function registerSystemHandlers(dataDir: string): void {
  ipcMain.handle(IPC.systemHardware, () => detectHardware(dataDir));
}
