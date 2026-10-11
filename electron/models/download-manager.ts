// Gerenciador de downloads genérico (modelos agora; Parquet na Semana 8).
// Sem dependência do Electron: testável com `node --test` contra um servidor HTTP local.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs, truncate } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { DownloadProgress, DownloadState } from "../../shared/models";

export interface DownloadRequest {
  id: string;
  url: string;
  /** Caminho final; o parcial é `<destPath>.part`. */
  destPath: string;
  expectedSha256?: string;
  expectedSize?: number;
}

export interface DownloadManagerOptions {
  /** Downloads simultâneos (1 por padrão, máximo 2). */
  concurrency?: number;
  /** Throttle dos eventos de progresso: o que vier primeiro (o de bytes respeita um piso de 1/4 do intervalo). */
  progressIntervalMs?: number;
  progressIntervalBytes?: number;
  /** Janela da média de velocidade. */
  speedWindowMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Chamado depois que o arquivo verificado foi movido para `destPath`. */
  onCompleted?: (request: DownloadRequest, sha256: string) => void | Promise<void>;
  fetchImpl?: typeof fetch;
}

interface Task {
  request: DownloadRequest;
  state: DownloadState;
  bytes: number;
  total: number | null;
  error?: string;
  controller?: AbortController;
  abortReason?: "pause" | "cancel";
  running?: Promise<void>;
  samples: Array<{ t: number; bytes: number }>;
  lastEmit: { t: number; bytes: number };
}

/** Erro de rede: o download vai para `paused` e pode ser retomado. */
class RecoverableError extends Error {}

const FS_FATAL_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR", "EDQUOT"]);

export function partPathOf(destPath: string): string {
  return `${destPath}.part`;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export class DownloadManager {
  private readonly tasks = new Map<string, Task>();
  private readonly queue: string[] = [];
  private active = 0;
  private readonly concurrency: number;
  private readonly progressIntervalMs: number;
  private readonly progressIntervalBytes: number;
  private readonly speedWindowMs: number;
  private readonly onProgress?: (progress: DownloadProgress) => void;
  private readonly onCompleted?: DownloadManagerOptions["onCompleted"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: DownloadManagerOptions = {}) {
    this.concurrency = Math.min(2, Math.max(1, options.concurrency ?? 1));
    this.progressIntervalMs = options.progressIntervalMs ?? 200;
    this.progressIntervalBytes = options.progressIntervalBytes ?? 1024 * 1024;
    this.speedWindowMs = options.speedWindowMs ?? 5000;
    this.onProgress = options.onProgress;
    this.onCompleted = options.onCompleted;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Estado atual de um download conhecido (ou `undefined`). */
  get(id: string): DownloadProgress | undefined {
    const task = this.tasks.get(id);
    return task && this.snapshot(task);
  }

  list(): DownloadProgress[] {
    return [...this.tasks.values()].map((task) => this.snapshot(task));
  }

  /**
   * Registra um download interrompido numa execução anterior (existe `.part` no disco)
   * como `paused`, sem iniciar. Retorna `false` se não houver `.part`.
   */
  async restore(request: DownloadRequest): Promise<boolean> {
    if (this.tasks.has(request.id)) return true;
    const bytes = await fileSize(partPathOf(request.destPath));
    if (bytes === 0) return false;
    const task = this.createTask(request, "paused");
    task.bytes = bytes;
    this.emit(task, true);
    return true;
  }

  /** Enfileira (FIFO). Se já existir um `.part`, continua dele. */
  enqueue(request: DownloadRequest): void {
    const existing = this.tasks.get(request.id);
    if (existing) {
      if (existing.state === "paused" || existing.state === "error") {
        existing.request = request;
        this.resume(request.id);
      }
      return; // já na fila/baixando/verificando
    }
    const task = this.createTask(request, "queued");
    this.queue.push(request.id);
    this.emit(task, true);
    this.pump();
  }

  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.state === "queued") {
      this.removeFromQueue(id);
      this.setState(task, "paused");
    } else if (task.controller && !task.abortReason) {
      task.abortReason = "pause";
      task.controller.abort();
    }
  }

  resume(id: string): void {
    const task = this.tasks.get(id);
    if (!task || (task.state !== "paused" && task.state !== "error")) return;
    task.error = undefined;
    this.queue.push(id);
    this.setState(task, "queued");
    this.pump();
  }

  /** Aborta (se ativo) e apaga o `.part`. Resolve quando o arquivo já foi removido. */
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.controller) {
      task.abortReason = "cancel";
      task.controller.abort();
      await task.running;
      return;
    }
    this.removeFromQueue(id);
    await rm(partPathOf(task.request.destPath), { force: true });
    this.finishCanceled(task);
  }

  /** Para tudo mantendo os `.part` (fechamento do app). */
  async shutdown(): Promise<void> {
    this.queue.length = 0;
    const running: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (task.controller) {
        task.abortReason ??= "pause";
        task.controller.abort();
        if (task.running) running.push(task.running);
      }
    }
    await Promise.allSettled(running);
  }

  // ---------------------------------------------------------------------------

  private createTask(request: DownloadRequest, state: DownloadState): Task {
    const task: Task = {
      request,
      state,
      bytes: 0,
      total: request.expectedSize ?? null,
      samples: [],
      lastEmit: { t: 0, bytes: 0 },
    };
    this.tasks.set(request.id, task);
    return task;
  }

  private removeFromQueue(id: string): void {
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.state !== "queued") continue;
      this.active++;
      task.running = this.run(task).finally(() => {
        this.active--;
        task.running = undefined;
        this.pump();
      });
    }
  }

  private async run(task: Task): Promise<void> {
    const controller = new AbortController();
    task.controller = controller;
    task.abortReason = undefined;
    task.samples = [];
    const partPath = partPathOf(task.request.destPath);
    try {
      await this.download(task, controller.signal);
      const sha256 = await this.verify(task, controller.signal);
      await rename(partPath, task.request.destPath);
      task.controller = undefined;
      await this.onCompleted?.(task.request, sha256);
      this.setState(task, "completed");
      this.tasks.delete(task.request.id);
    } catch (error) {
      const reason = task.abortReason;
      task.controller = undefined;
      task.abortReason = undefined;
      if (reason === "cancel") {
        await rm(partPath, { force: true });
        this.finishCanceled(task);
      } else if (reason === "pause") {
        task.bytes = await fileSize(partPath);
        this.setState(task, "paused");
      } else if (error instanceof RecoverableError) {
        task.bytes = await fileSize(partPath);
        task.error = `Conexão interrompida: ${error.message}. Clique em Retomar para continuar de onde parou.`;
        this.setState(task, "paused");
      } else {
        task.error = errorMessage(error);
        this.setState(task, "error");
      }
    } finally {
      task.controller = undefined;
    }
  }

  private async download(task: Task, signal: AbortSignal): Promise<void> {
    const { request } = task;
    const partPath = partPathOf(request.destPath);
    await mkdir(path.dirname(request.destPath), { recursive: true });

    let offset = await fileSize(partPath);
    if (request.expectedSize !== undefined && offset > request.expectedSize) {
      // `.part` maior que o esperado não tem conserto: recomeça.
      await truncate(partPath, 0);
      offset = 0;
    }
    task.bytes = offset;
    if (request.expectedSize !== undefined && offset === request.expectedSize) return; // só falta verificar

    if (request.expectedSize !== undefined) {
      await this.assertFreeSpace(path.dirname(request.destPath), request.expectedSize - offset);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RecoverableError(errorMessage(error));
    }

    console.info(
      `[download] ${request.id}: GET ${offset > 0 ? `Range=bytes=${offset}-` : "(sem Range)"} → HTTP ${response.status}` +
        `${response.redirected ? " (após redirect)" : ""}, content-length=${response.headers.get("content-length")}`,
    );
    if (response.status === 416 && offset > 0) {
      // Range fora do arquivo: o `.part` já tem tudo (ou está inconsistente); a verificação decide.
      await response.body?.cancel();
      return;
    }
    let append: boolean;
    if (response.status === 206 && offset > 0) {
      append = true;
    } else if (response.status === 200) {
      append = false; // servidor ignorou o Range: recomeça do zero
      offset = 0;
    } else {
      await response.body?.cancel();
      const error = new Error(`O servidor respondeu HTTP ${response.status} ${response.statusText}.`.trim());
      if (response.status >= 500 || response.status === 429) throw new RecoverableError(error.message);
      throw error;
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0) {
      task.total = offset + contentLength;
      if (request.expectedSize === undefined) {
        await this.assertFreeSpace(path.dirname(request.destPath), contentLength);
      }
    }
    if (!response.body) throw new RecoverableError("resposta sem corpo");

    task.bytes = offset;
    this.setState(task, "downloading");

    const counter = this.byteCounter(task);
    const output = createWriteStream(partPath, { flags: append ? "a" : "w" });
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), counter, output, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code && FS_FATAL_CODES.has(code)) throw error;
      throw new RecoverableError(errorMessage(error));
    } finally {
      // No Windows, renomear/apagar falha com o arquivo aberto: espera o descritor fechar.
      if (!output.closed) await new Promise<void>((resolve) => output.once("close", () => resolve()));
    }

    if (request.expectedSize !== undefined && task.bytes !== request.expectedSize) {
      const received = task.bytes;
      if (received < request.expectedSize) {
        throw new RecoverableError(`recebidos ${received} de ${request.expectedSize} bytes`);
      }
      await rm(partPath, { force: true });
      throw new Error(`Tamanho inesperado: ${received} bytes (esperado ${request.expectedSize}). O arquivo foi apagado.`);
    }
  }

  private byteCounter(task: Task) {
    return async function* (this: DownloadManager, source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        task.bytes += chunk.byteLength;
        this.emit(task, false);
        yield chunk;
      }
    }.bind(this);
  }

  private async verify(task: Task, signal: AbortSignal): Promise<string> {
    const { request } = task;
    const partPath = partPathOf(request.destPath);
    const size = await fileSize(partPath);
    task.total = size;
    task.bytes = 0;
    task.samples = [];
    this.setState(task, "verifying");

    const hash = createHash("sha256");
    await pipeline(
      createReadStream(partPath),
      async function (this: DownloadManager, source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          task.bytes += chunk.byteLength;
          this.emit(task, false);
        }
      }.bind(this),
      { signal },
    );
    const actual = hash.digest("hex");
    task.bytes = size;
    const expected = request.expectedSha256?.toLowerCase();
    if (expected && actual !== expected) {
      await rm(partPath, { force: true });
      throw new Error(
        `Arquivo corrompido: o SHA-256 não confere (esperado ${expected.slice(0, 12)}…, obtido ${actual.slice(0, 12)}…). ` +
          "O arquivo baixado foi apagado; instale novamente.",
      );
    }
    return actual;
  }

  private async assertFreeSpace(dir: string, neededBytes: number): Promise<void> {
    if (neededBytes <= 0) return;
    const fsStats = await statfs(dir);
    const free = fsStats.bavail * fsStats.bsize;
    if (free < neededBytes) {
      throw new Error(
        `Espaço insuficiente em disco: são necessários ${formatGiB(neededBytes)} e há ${formatGiB(free)} livres em ${dir}.`,
      );
    }
  }

  private finishCanceled(task: Task): void {
    task.bytes = 0;
    task.error = undefined;
    this.setState(task, "canceled");
    this.tasks.delete(task.request.id);
  }

  private setState(task: Task, state: DownloadState): void {
    task.state = state;
    if (state !== "error" && state !== "paused") task.error = undefined;
    this.emit(task, true);
  }

  private emit(task: Task, force: boolean): void {
    const now = Date.now();
    if (task.state === "downloading" || task.state === "verifying") {
      task.samples.push({ t: now, bytes: task.bytes });
      while (task.samples.length > 2 && now - task.samples[0].t > this.speedWindowMs) task.samples.shift();
    }
    const elapsed = now - task.lastEmit.t;
    // Gatilho por bytes só a partir de 1/4 do intervalo: o hash local passa de 100 MB/s e,
    // sem esse piso, "a cada 1 MB" viraria ~100 eventos/s.
    const due =
      elapsed >= this.progressIntervalMs ||
      (task.bytes - task.lastEmit.bytes >= this.progressIntervalBytes && elapsed >= this.progressIntervalMs / 4);
    if (!force && !due) return;
    task.lastEmit = { t: now, bytes: task.bytes };
    this.onProgress?.(this.snapshot(task));
  }

  private snapshot(task: Task): DownloadProgress {
    let bytesPerSecond = 0;
    if ((task.state === "downloading" || task.state === "verifying") && task.samples.length >= 2) {
      const first = task.samples[0];
      const last = task.samples[task.samples.length - 1];
      const seconds = (last.t - first.t) / 1000;
      if (seconds > 0) bytesPerSecond = Math.max(0, (last.bytes - first.bytes) / seconds);
    }
    const remaining = task.total !== null ? Math.max(0, task.total - task.bytes) : null;
    const etaSeconds = remaining !== null && bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null;
    return {
      id: task.request.id,
      state: task.state,
      bytesDownloaded: task.bytes,
      totalBytes: task.total,
      bytesPerSecond: Math.round(bytesPerSecond),
      etaSeconds,
      ...(task.error ? { error: task.error } : {}),
    };
  }
}
