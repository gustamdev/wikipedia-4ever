import { useCallback, useEffect, useState } from "react";
import type { IngestionProgress, IngestionStatus, KnowledgeBase } from "../../shared/ingestion";

export interface IngestionState {
  status: IngestionStatus | null;
  /** Progresso mais recente (o do `status` até chegar o primeiro evento). */
  progress: IngestionProgress | null;
  bases: KnowledgeBase[];
  error: string | null;
  refresh: () => void;
}

/** Estado da indexação: busca `ingestion:status` e acompanha os eventos de progresso e de mudança de estado. */
export function useIngestion(): IngestionState {
  const [status, setStatus] = useState<IngestionStatus | null>(null);
  const [progress, setProgress] = useState<IngestionProgress | null>(null);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const api = window.electronAPI.ingestion;
    Promise.all([api.status(), api.knowledgeBases()])
      .then(([nextStatus, nextBases]) => {
        setStatus(nextStatus);
        setProgress(nextStatus.progress);
        setBases(nextBases);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const offStatus = window.electronAPI.ingestion.onStatusChanged(refresh);
    const offProgress = window.electronAPI.ingestion.onProgress(setProgress);
    return () => {
      offStatus();
      offProgress();
    };
  }, [refresh]);

  return { status, progress, bases, error, refresh };
}
