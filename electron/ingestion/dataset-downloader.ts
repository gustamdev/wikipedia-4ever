// Download dos Parquets com o `DownloadManager` genérico (Semana 2): Range/retomada de `.part`,
// SHA-256 e checagem de espaço já vêm dele. Aqui só o adaptador para uma promessa por arquivo.
import type { DownloadProgress } from "../../shared/models";
import { AbortError, type DownloadReport, type PipelineDeps } from "./pipeline.ts";
import type { DatasetFile } from "./hf-datasets";
import { DownloadManager } from "../models/download-manager.ts";

export interface DatasetDownloader {
  downloadFile: PipelineDeps["downloadFile"];
  /** Fechamento: pausa o que estiver baixando (o `.part` fica no disco). */
  shutdown(): Promise<void>;
}

export function createDatasetDownloader(fetchImpl?: typeof fetch): DatasetDownloader {
  const listeners = new Map<string, (progress: DownloadProgress) => void>();
  const manager = new DownloadManager({
    concurrency: 1,
    fetchImpl,
    onProgress: (progress) => listeners.get(progress.id)?.(progress),
  });

  return {
    downloadFile(file: DatasetFile, destPath: string, onProgress: (report: DownloadReport) => void, signal: AbortSignal) {
      const id = `dataset:${destPath}`;
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new AbortError());
        const finish = (outcome: () => void) => {
          listeners.delete(id);
          signal.removeEventListener("abort", onAbort);
          outcome();
        };
        // Cancelar a ingestão PAUSA o download: o `.part` fica e "Retomar" continua de onde parou.
        const onAbort = () => manager.pause(id);
        signal.addEventListener("abort", onAbort, { once: true });
        listeners.set(id, (progress) => {
          switch (progress.state) {
            case "completed":
              return finish(resolve);
            case "error":
              return finish(() => reject(new Error(progress.error ?? "Falha no download.")));
            case "canceled":
              return finish(() => reject(new AbortError()));
            case "paused":
              return finish(() => reject(signal.aborted ? new AbortError() : new Error(progress.error ?? "Download interrompido.")));
            default:
              onProgress({
                bytes: progress.bytesDownloaded,
                total: progress.totalBytes ?? file.size,
                bytesPerSecond: progress.bytesPerSecond,
                verifying: progress.state === "verifying",
              });
          }
        });
        manager.enqueue({ id, url: file.url, destPath, expectedSha256: file.sha256, expectedSize: file.size });
      });
    },
    shutdown: () => manager.shutdown(),
  };
}
