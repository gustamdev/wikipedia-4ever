// Ciclo de vida dos modelos: instalar (DownloadManager), remover, padrão, carregar/trocar (LlmRuntime).
// Sem dependência do Electron: recebe o diretório de dados e callbacks de eventos.
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../../shared/electron-api";
import type { ActiveModel, CatalogModel, DownloadProgress, ModelListItem, ModelStatus } from "../../shared/models";
import { modelStatusFromProgress } from "../../shared/models";
import { ConfigStore, type InstalledModel } from "../config/config-store";
import type { LlmGenerateResult, LlmRuntime } from "../llm/runtime";
import { findCatalogModel, MODEL_CATALOG } from "./catalog";
import { DownloadManager, type DownloadRequest } from "./download-manager";

export interface ModelManagerOptions {
  /** userData: onde ficam `config.json` e, por padrão, `models/`. */
  dataDir: string;
  runtime: LlmRuntime;
  onDownloadProgress: (progress: DownloadProgress) => void;
  onActiveChanged: (active: ActiveModel) => void;
  /** Instalados/padrão mudaram (instalação concluída, remoção, novo padrão). */
  onModelsChanged: () => void;
  /** Override de desenvolvimento (`W4E_DEV_MODEL`): carregado na abertura no lugar do padrão. */
  devModelPath?: string | null;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  onTextChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

async function statOrNull(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ModelManager {
  readonly config: ConfigStore;
  private readonly runtime: LlmRuntime;
  private readonly options: ModelManagerOptions;
  private readonly downloads: DownloadManager;
  private activeModel: ActiveModel = { id: null, name: null, state: "none" };
  private loadSeq = 0;
  private loadController: AbortController | null = null;

  constructor(options: ModelManagerOptions) {
    this.options = options;
    this.runtime = options.runtime;
    this.config = new ConfigStore(options.dataDir);
    this.downloads = new DownloadManager({
      concurrency: 1,
      onProgress: options.onDownloadProgress,
      onCompleted: async (request, sha256) => {
        await this.config.update((c) => {
          c.installedModels = c.installedModels.filter((m) => m.id !== request.id);
          c.installedModels.push({ id: request.id, path: request.destPath, sha256, installedAt: new Date().toISOString() });
        });
        options.onModelsChanged();
      },
    });
  }

  /** Reconcilia `config.json` com o disco: `<id>.gguf` com o tamanho certo → instalado; `.part` → pausado. */
  async init(): Promise<void> {
    const saved = await this.config.load();
    await mkdir(saved.modelsDir, { recursive: true });

    const installed: InstalledModel[] = [];
    for (const model of MODEL_CATALOG) {
      const request = this.requestFor(model);
      const file = await statOrNull(request.destPath);
      if (file?.isFile() && file.size === model.sizeBytes) {
        installed.push(
          saved.installedModels.find((m) => m.id === model.id && m.path === request.destPath) ?? {
            id: model.id,
            path: request.destPath,
            sha256: model.sha256,
            installedAt: file.mtime.toISOString(),
          },
        );
      } else {
        await this.downloads.restore(request);
      }
    }
    const defaultModelId = installed.some((m) => m.id === saved.defaultModelId) ? saved.defaultModelId : null;
    if (JSON.stringify(installed) !== JSON.stringify(saved.installedModels) || defaultModelId !== saved.defaultModelId) {
      await this.config.update((c) => {
        c.installedModels = installed;
        c.defaultModelId = defaultModelId;
      });
    }
  }

  /** Carrega em background o override de dev ou o modelo padrão (não bloqueia a janela). */
  startDefaultLoad(): void {
    const dev = this.options.devModelPath;
    const task = dev
      ? this.loadPath(dev, null, `dev: ${path.basename(dev)}`)
      : this.config.get().defaultModelId
        ? this.load(this.config.get().defaultModelId!)
        : null;
    task?.catch((error) => console.error("Falha ao carregar o modelo na abertura:", errorMessage(error)));
  }

  list(): ModelListItem[] {
    const { defaultModelId } = this.config.get();
    return MODEL_CATALOG.map((model) => ({
      ...model,
      status: this.statusOf(model),
      isDefault: model.id === defaultModelId,
    }));
  }

  active(): ActiveModel {
    return { ...this.activeModel };
  }

  // ---- downloads ------------------------------------------------------------

  install(id: string): void {
    const model = this.catalogModel(id);
    if (!this.installed(id)) this.downloads.enqueue(this.requestFor(model));
  }

  pause(id: string): void {
    this.downloads.pause(this.catalogModel(id).id);
  }

  resume(id: string): void {
    const model = this.catalogModel(id);
    if (this.downloads.get(id)) this.downloads.resume(id);
    else if (!this.installed(id)) this.downloads.enqueue(this.requestFor(model));
  }

  cancel(id: string): Promise<void> {
    return this.downloads.cancel(this.catalogModel(id).id);
  }

  // ---- ciclo de vida --------------------------------------------------------

  /** Descarrega (se ativo/carregando) e apaga o `.gguf`; limpa o padrão se era ele. */
  async remove(id: string): Promise<void> {
    const model = this.catalogModel(id);
    await this.downloads.cancel(id); // download em andamento/pausado também é descartado
    const entry = this.installed(id);
    if (!entry) return;

    if (this.activeModel.id === id) await this.unloadActive();
    try {
      await rm(entry.path, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        throw new Error(
          `Não foi possível apagar ${model.name}: o arquivo está em uso (${code}). Feche outros programas que o usem e tente de novo.`,
        );
      }
      throw error;
    }
    await this.config.update((c) => {
      c.installedModels = c.installedModels.filter((m) => m.id !== id);
      if (c.defaultModelId === id) c.defaultModelId = null;
    });
    this.options.onModelsChanged();
  }

  async setDefault(id: string): Promise<void> {
    const model = this.catalogModel(id);
    if (!this.installed(id)) throw new Error(`${model.name} não está instalado.`);
    await this.config.update((c) => {
      c.defaultModelId = id;
    });
    this.options.onModelsChanged();
  }

  /** Carrega/troca o modelo ativo. Trocas concorrentes: a última vence, a anterior é cancelada. */
  async load(id: string): Promise<void> {
    const model = this.catalogModel(id);
    const entry = this.installed(id);
    if (!entry) throw new Error(`${model.name} não está instalado.`);
    if (this.activeModel.id === id && this.activeModel.state === "ready" && this.runtime.loadedPath === entry.path) return;
    await this.loadPath(entry.path, id, model.name);
  }

  /** Gera com o modelo ativo; durante um carregamento, aguarda ele terminar. */
  generate(options: GenerateOptions): Promise<LlmGenerateResult> {
    return this.whenUsable(() => this.runtime.generate(options));
  }

  /** Tokens do prompt com o chat template do modelo ativo (orçamento do RAG). */
  countPromptTokens(messages: GenerateOptions["messages"]): Promise<number> {
    return this.whenUsable(() => this.runtime.countPromptTokens(messages));
  }

  countTextTokens(text: string): Promise<number> {
    return this.whenUsable(() => this.runtime.countTextTokens(text));
  }

  contextSize(): Promise<number> {
    return this.whenUsable(() => this.runtime.contextSize());
  }

  private whenUsable<T>(run: () => Promise<T>): Promise<T> {
    const { state, error } = this.activeModel;
    if (state === "none") return Promise.reject(new Error("Nenhum modelo carregado. Escolha um modelo no topo da tela."));
    if (state === "error") return Promise.reject(new Error(`O modelo não carregou: ${error ?? "erro desconhecido"}`));
    return run();
  }

  /** Fechamento do app: para downloads (mantendo `.part`) e libera o runtime. */
  async shutdown(): Promise<void> {
    this.loadController?.abort();
    await Promise.allSettled([this.downloads.shutdown(), this.runtime.dispose()]);
  }

  // ---------------------------------------------------------------------------

  private async loadPath(modelPath: string, id: string | null, name: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.setActive({ id, name, state: "loading" });

    const { llm } = this.config.get();
    const started = Date.now();
    try {
      await this.runtime.load({ modelPath, contextSize: llm.contextSize, threads: llm.threads, signal: controller.signal });
    } catch (error) {
      if (seq !== this.loadSeq) throw new Error(`Carregamento de ${name} cancelado: outro modelo foi escolhido.`);
      this.setActive({ id, name, state: "error", error: errorMessage(error) });
      throw error;
    }
    if (seq !== this.loadSeq) throw new Error(`Carregamento de ${name} cancelado: outro modelo foi escolhido.`);
    this.loadController = null;
    console.info(`[models] ${name} carregado em ${Date.now() - started} ms (${this.runtime.info?.backend ?? "?"})`);
    this.setActive({ id, name, state: "ready" });
  }

  private async unloadActive(): Promise<void> {
    this.loadSeq++;
    this.loadController?.abort();
    this.loadController = null;
    await this.runtime.unload();
    this.setActive({ id: null, name: null, state: "none" });
  }

  private setActive(active: ActiveModel): void {
    this.activeModel = active;
    this.options.onActiveChanged({ ...active });
  }

  private statusOf(model: CatalogModel): ModelStatus {
    const progress = this.downloads.get(model.id);
    if (progress) return modelStatusFromProgress(progress);
    return this.installed(model.id) ? { state: "installed" } : { state: "not_installed" };
  }

  private installed(id: string): InstalledModel | undefined {
    return this.config.get().installedModels.find((m) => m.id === id);
  }

  private catalogModel(id: string): CatalogModel {
    const model = findCatalogModel(id);
    if (!model) throw new Error("Modelo desconhecido.");
    return model;
  }

  private requestFor(model: CatalogModel): DownloadRequest {
    return {
      id: model.id,
      url: model.downloadUrl,
      destPath: path.join(this.config.get().modelsDir, `${model.id}.gguf`),
      expectedSha256: model.sha256,
      expectedSize: model.sizeBytes,
    };
  }
}
