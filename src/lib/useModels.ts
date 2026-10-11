import { useCallback, useEffect, useState } from "react";
import { modelStatusFromProgress, type ModelListItem } from "../../shared/models";

export interface ModelsState {
  models: ModelListItem[] | null;
  error: string | null;
  reload: () => void;
}

/** Catálogo + status, atualizado pelos eventos `download:progress` (push, sem polling). */
export function useModels(): ModelsState {
  const [models, setModels] = useState<ModelListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    window.electronAPI.models
      .list()
      .then(setModels)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reload();
    const offChanged = window.electronAPI.models.onChanged(reload);
    const offProgress = window.electronAPI.models.onDownloadProgress((progress) => {
      setModels((current) =>
        current?.map((model) =>
          model.id === progress.id ? { ...model, status: modelStatusFromProgress(progress) } : model,
        ) ?? current,
      );
    });
    return () => {
      offChanged();
      offProgress();
    };
  }, [reload]);

  return { models, error, reload };
}
