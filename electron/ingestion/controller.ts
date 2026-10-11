// Orquestra a ingestão no lado do Main: guarda o estado visível à UI, cria/encerra o worker
// (utilityProcess), registra a base em `config.json` e faz a estimativa de espaço. Sem dependência
// do Electron: o `fork` do worker e o envio de eventos entram por `options`.
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SNAPSHOT,
  knowledgeBaseId,
  type DatasetLanguage,
  type IngestionEstimate,
  type IngestionProgress,
  type IngestionRequest,
  type IngestionStatus,
  type IngestionSummary,
  type KnowledgeBase,
  type MainToWorker,
  type WorkerPaths,
  type WorkerToMain,
} from "../../shared/ingestion.ts";
import type { ConfigStore } from "../config/config-store.ts";
import { directorySize } from "../vector/vector-store.ts";
import { estimateIngestion } from "./estimate.ts";
import { assertDatasetId, listDatasetFiles, listLanguages, type DatasetFile } from "./hf-datasets.ts";
import { partPathOf } from "../models/download-manager.ts";
import { IngestionStateStore } from "./state.ts";

/** O que o controller precisa de um worker (um `utilityProcess` no app; um processo filho nos testes). */
export interface WorkerHandle {
  postMessage(message: MainToWorker): void;
  onMessage(handler: (message: WorkerToMain) => void): void;
  /** `code` null = encerrado por sinal. */
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export interface IngestionControllerOptions {
  paths: WorkerPaths;
  config: ConfigStore;
  embeddingModel: string;
  fork(): WorkerHandle;
  onProgress(progress: IngestionProgress): void;
  /** Estado mudou (iniciou, cancelou, terminou…): a UI busca `status()`. */
  onStatusChanged(): void;
  /** Textos por lote de embeddings. */
  batchSize?: number;
  /** Testes: lista de arquivos e idiomas sem rede. */
  listFiles?: (language: string, snapshot: string) => Promise<DatasetFile[]>;
  listLanguages?: (snapshot: string) => Promise<DatasetLanguage[]>;
  freeBytes?: (dir: string) => Promise<number>;
}

const SHUTDOWN_GRACE_MS = 6000;

async function freeBytesOf(dir: string): Promise<number> {
  // A pasta de datasets pode ainda não existir: mede o primeiro ancestral que existe.
  let current = dir;
  for (;;) {
    try {
      const info = await statfs(current);
      return info.bavail * info.bsize;
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function sizeOrZero(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export class IngestionController {
  private readonly options: IngestionControllerOptions;
  private readonly stateStore: IngestionStateStore;
  private worker: WorkerHandle | null = null;
  private workerDone: Promise<void> = Promise.resolve();
  /** Gravação da base em config.json depois do fim do worker (o fechamento do app espera). */
  private registering: Promise<void> = Promise.resolve();
  private current: IngestionStatus = {
    state: "idle",
    language: null,
    snapshot: null,
    progress: null,
    error: null,
    resumable: false,
    summary: null,
  };
  private languagesCache: DatasetLanguage[] | null = null;
  private shuttingDown = false;

  constructor(options: IngestionControllerOptions) {
    this.options = options;
    this.stateStore = new IngestionStateStore(options.paths.stateFile);
  }

  /** Lê o estado salvo: uma ingestão interrompida numa execução anterior aparece como parcial/retomável. */
  async init(): Promise<void> {
    const saved = await this.stateStore.load();
    if (saved && saved.phase !== "done") {
      this.current = {
        ...this.current,
        state: "partial",
        language: saved.language,
        snapshot: saved.snapshot,
        resumable: true,
        progress: null,
      };
    }
  }

  /** Há um worker vivo (rodando ou terminando o cancelamento): ele é o único que escreve no banco. */
  isRunning(): boolean {
    return this.worker !== null;
  }

  status(): IngestionStatus {
    return structuredClone(this.current);
  }

  async languages(): Promise<DatasetLanguage[]> {
    this.languagesCache ??= await (this.options.listLanguages ?? ((s) => listLanguages(s)))(DEFAULT_SNAPSHOT);
    return this.languagesCache;
  }

  async estimate(language: string, snapshot = DEFAULT_SNAPSHOT): Promise<IngestionEstimate> {
    assertDatasetId(language, snapshot);
    const files = await (this.options.listFiles ?? ((l, s) => listDatasetFiles(l, s)))(language, snapshot);
    const dir = path.join(this.options.paths.datasetsDir, `${snapshot}.${language}`);
    const presentBytes = new Map<string, number>();
    for (const file of files) {
      const dest = path.join(dir, file.name);
      presentBytes.set(file.name, (await sizeOrZero(dest)) || (await sizeOrZero(partPathOf(dest))));
    }
    const freeBytes = await (this.options.freeBytes ?? freeBytesOf)(this.options.paths.datasetsDir);
    return estimateIngestion({ language, snapshot, files, presentBytes, freeBytes });
  }

  /** Recusa se já houver uma ingestão ou se o espaço estimado não couber. */
  async start(request: IngestionRequest): Promise<void> {
    this.assertIdle();
    const snapshot = request.snapshot ?? DEFAULT_SNAPSHOT;
    const estimate = await this.estimate(request.language, snapshot);
    if (!estimate.sufficient) {
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
      throw new Error(
        `Espaço insuficiente: a indexação precisa de cerca de ${gb(estimate.totalBytes)} e há ${gb(estimate.freeBytes)} livres.`,
      );
    }
    this.assertIdle(); // a estimativa é assíncrona: outra chamada pode ter começado nesse intervalo
    this.launch({ ...request, snapshot }, false);
  }

  async resume(): Promise<void> {
    this.assertIdle();
    const saved = await this.stateStore.load();
    if (!saved || saved.phase === "done") throw new Error("Não há ingestão interrompida para retomar.");
    this.launch({ language: saved.language, snapshot: saved.snapshot, deleteRaw: saved.deleteRaw }, true);
  }

  /** Cooperativo: o worker termina o lote em andamento, grava o parcial e avisa. */
  cancel(): void {
    if (this.current.state !== "running" || !this.worker) return;
    this.set({ state: "canceling" });
    this.worker.postMessage({ type: "cancel" });
  }

  /**
   * Fechamento do app: pede cancelamento e, passado o prazo, encerra o processo. O que foi gravado
   * fica, e a base parcial é registrada em config.json antes de o app sair.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    if (worker) {
      worker.postMessage({ type: "cancel" });
      const timer = setTimeout(() => worker.kill(), SHUTDOWN_GRACE_MS);
      timer.unref();
      await this.workerDone;
      clearTimeout(timer);
    }
    await this.registering;
  }

  // ---------------------------------------------------------------------------------------------

  private assertIdle(): void {
    if (this.current.state === "running" || this.current.state === "canceling" || this.worker) {
      throw new Error("Já existe uma indexação em andamento.");
    }
  }

  private set(patch: Partial<IngestionStatus>): void {
    this.current = { ...this.current, ...patch };
    this.options.onStatusChanged();
  }

  private launch(request: IngestionRequest & { snapshot: string }, resume: boolean): void {
    const worker = this.options.fork();
    this.worker = worker;
    let terminal = false;
    let resolveDone!: () => void;
    this.workerDone = new Promise<void>((resolve) => (resolveDone = resolve));

    const finish = (patch: Partial<IngestionStatus>, kb: { articles: number; chunks: number; complete: boolean; summary?: IngestionSummary }) => {
      if (terminal) return;
      terminal = true;
      this.registering = this.registerKnowledgeBase(request, kb).catch((error) => console.error("[ingestion] registro da base falhou:", error));
      this.worker = null;
      worker.kill(); // o worker já limpou tudo antes de avisar; isso só garante que o processo saia
      this.set(patch);
      resolveDone();
    };

    worker.onMessage((message) => {
      switch (message.type) {
        case "progress":
          this.current = { ...this.current, progress: message.progress };
          this.options.onProgress(message.progress);
          break;
        case "done":
          finish(
            { state: "completed", progress: null, resumable: false, summary: message.summary, error: null },
            { articles: message.summary.articles, chunks: message.summary.chunks, complete: true, summary: message.summary },
          );
          break;
        case "canceled":
          finish(
            { state: "partial", resumable: true, error: null },
            { articles: message.articles, chunks: message.chunks, complete: false },
          );
          break;
        case "error":
          // Há o que retomar enquanto o estado salvo existir (o download pode ter caído antes do 1º artigo).
          void this.stateStore.load().then((saved) =>
            finish(
              { state: "error", error: message.message, resumable: saved !== null },
              { articles: message.articles, chunks: message.chunks, complete: false },
            ),
          );
          break;
      }
    });
    worker.onExit((code) => {
      if (terminal) return;
      const reason = this.shuttingDown
        ? "O app foi fechado durante a indexação."
        : `O processo de indexação terminou inesperadamente (código ${code ?? "sinal"}).`;
      void this.stateStore.load().then((saved) =>
        finish(
          { state: this.shuttingDown ? "partial" : "error", error: this.shuttingDown ? null : reason, resumable: saved !== null },
          { articles: saved?.articles ?? 0, chunks: saved?.chunks ?? 0, complete: false },
        ),
      );
      console.warn(`[ingestion] ${reason}`);
    });

    this.current = {
      state: "running",
      language: request.language,
      snapshot: request.snapshot,
      progress: null,
      error: null,
      resumable: false,
      summary: null,
    };
    this.options.onStatusChanged();
    worker.postMessage({
      type: "start",
      request,
      paths: this.options.paths,
      batchSize: this.options.batchSize,
      resume,
    });
  }

  /** Mantém `config.json` com a base e o que ela tem de utilizável (parcial ou completa). */
  private async registerKnowledgeBase(
    request: IngestionRequest & { snapshot: string },
    result: { articles: number; chunks: number; complete: boolean; summary?: IngestionSummary },
  ): Promise<void> {
    const id = knowledgeBaseId(request.language);
    const sizeOnDiskBytes = result.summary?.sizeOnDiskBytes ?? (await directorySize(this.options.paths.vectorDir));
    await this.options.config.update((config) => {
      const previous = config.knowledgeBases.find((kb) => kb.id === id);
      const base: KnowledgeBase = {
        id,
        language: request.language,
        snapshot: request.snapshot,
        status: result.complete ? "complete" : "partial",
        documents: result.articles,
        chunks: result.chunks,
        sizeOnDiskBytes,
        embeddingModel: this.options.embeddingModel,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      };
      config.knowledgeBases = [...config.knowledgeBases.filter((kb) => kb.id !== id), base];
    });
  }
}
