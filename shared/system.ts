// Hardware e recomendação de modelo (apenas tipos e funções puras).

export interface HardwareInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamBytes: number;
  freeRamBytes: number;
  /** Diretório de dados do app (userData). */
  dataDir: string;
  /** Espaço livre no disco de `dataDir`. */
  freeDiskBytes: number;
}

export type ModelFit = "recommended" | "tight" | "not_recommended";

/**
 * Heurística por RAM total (spec §5):
 * < 1× recomendado → ✕; [1×, 2×) → ⚠; ≥ 2× → ✓.
 * Pesos Q4 ocupam ~o tamanho do arquivo em RAM, mais KV cache, SO e o próprio app.
 */
export function recommendModel(
  model: { recommendedRamBytes: number },
  hw: { totalRamBytes: number },
): ModelFit {
  if (hw.totalRamBytes < model.recommendedRamBytes) return "not_recommended";
  if (hw.totalRamBytes < 2 * model.recommendedRamBytes) return "tight";
  return "recommended";
}
