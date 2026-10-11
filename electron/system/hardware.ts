// Detecção de hardware só com `os` e `fs` do Node (sem dependências; macOS e Windows).
import { mkdir, statfs } from "node:fs/promises";
import os from "node:os";
import type { HardwareInfo } from "../../shared/system";

export async function detectHardware(dataDir: string): Promise<HardwareInfo> {
  // No Windows o statfs precisa de um diretório existente.
  await mkdir(dataDir, { recursive: true });
  const disk = await statfs(dataDir);
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? "desconhecida",
    cpuCores: cpus.length,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    dataDir,
    freeDiskBytes: disk.bavail * disk.bsize,
  };
}
