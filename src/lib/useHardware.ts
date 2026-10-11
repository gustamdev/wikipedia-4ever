import { useEffect, useState } from "react";
import type { HardwareInfo } from "../../shared/system";

export function useHardware(): { hardware: HardwareInfo | null; error: string | null } {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.electronAPI.system
      .hardware()
      .then(setHardware)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return { hardware, error };
}
