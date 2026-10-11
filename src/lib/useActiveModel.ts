import { useEffect, useState } from "react";
import type { ActiveModel } from "../../shared/models";

/** Modelo carregado no Main, atualizado por `models:activeChanged` (push). */
export function useActiveModel(): ActiveModel | null {
  const [active, setActive] = useState<ActiveModel | null>(null);
  useEffect(() => {
    let gotEvent = false;
    const unsubscribe = window.electronAPI.models.onActiveChanged((next) => {
      gotEvent = true;
      setActive(next);
    });
    window.electronAPI.models
      .active()
      .then((initial) => {
        if (!gotEvent) setActive(initial);
      })
      .catch(() => undefined);
    return unsubscribe;
  }, []);
  return active;
}
