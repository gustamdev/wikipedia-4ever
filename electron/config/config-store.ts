// `config.json` em userData com escrita atômica (`.tmp` + `rename`), schema versionado e defaults
// aplicados campo a campo. Semana 4: `lastAgentId`. A Semana 10 acrescenta o restante.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBase } from "../../shared/ingestion";

export interface InstalledModel {
  id: string;
  path: string;
  sha256: string;
  installedAt: string;
}

export interface LlmConfig {
  contextSize: number;
  /** null = o node-llama-cpp decide. */
  threads: number | null;
}

export interface AppConfig {
  configVersion: 1;
  installedModels: InstalledModel[];
  defaultModelId: string | null;
  modelsDir: string;
  llm: LlmConfig;
  /** Agente usado em conversas novas (o último escolhido). */
  lastAgentId: string;
  /** Bases de conhecimento indexadas (Semana 8); a Semana 10 acrescenta a gestão na UI. */
  knowledgeBases: KnowledgeBase[];
}

const MIN_CONTEXT = 512;
const MAX_CONTEXT = 131_072;

function isInstalledModel(value: unknown): value is InstalledModel {
  const v = value as InstalledModel;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    typeof v.path === "string" &&
    typeof v.sha256 === "string" &&
    typeof v.installedAt === "string"
  );
}

function isKnowledgeBase(value: unknown): value is KnowledgeBase {
  const v = value as KnowledgeBase;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    typeof v.language === "string" &&
    typeof v.snapshot === "string" &&
    (v.status === "complete" || v.status === "partial") &&
    Number.isInteger(v.documents) &&
    Number.isInteger(v.chunks) &&
    typeof v.sizeOnDiskBytes === "number" &&
    typeof v.embeddingModel === "string" &&
    typeof v.createdAt === "string"
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export class ConfigStore {
  readonly filePath: string;
  private readonly dir: string;
  private config: AppConfig;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = path.join(dir, "config.json");
    this.config = this.defaults();
  }

  defaults(): AppConfig {
    return {
      configVersion: 1,
      installedModels: [],
      defaultModelId: null,
      modelsDir: path.join(this.dir, "models"),
      llm: { contextSize: 4096, threads: null },
      lastAgentId: "assistant",
      knowledgeBases: [],
    };
  }

  /** Lê o arquivo; inexistente → defaults; corrompido → backup `config.json.bak-<timestamp>` + defaults. */
  async load(): Promise<AppConfig> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.config = this.defaults();
      return this.get();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("a raiz não é um objeto");
      }
      this.config = this.normalize(parsed as Record<string, unknown>);
    } catch (error) {
      const backup = `${this.filePath}.bak-${Date.now()}`;
      await copyFile(this.filePath, backup);
      console.error(`config.json inválido (${(error as Error).message}); backup em ${backup}, usando defaults.`);
      this.config = this.defaults();
      await this.save();
    }
    return this.get();
  }

  get(): AppConfig {
    return structuredClone(this.config);
  }

  /** Aplica a mudança em memória e grava (gravações serializadas). */
  update(mutate: (config: AppConfig) => void): Promise<void> {
    mutate(this.config);
    return this.save();
  }

  /** Campo inválido ou ausente → default daquele campo (o resto é preservado). */
  private normalize(raw: Record<string, unknown>): AppConfig {
    const d = this.defaults();
    const llm = (typeof raw.llm === "object" && raw.llm !== null ? raw.llm : {}) as Record<string, unknown>;
    const contextSize = llm.contextSize;
    return {
      configVersion: 1,
      installedModels: Array.isArray(raw.installedModels) ? raw.installedModels.filter(isInstalledModel) : [],
      defaultModelId: typeof raw.defaultModelId === "string" ? raw.defaultModelId : null,
      modelsDir:
        typeof raw.modelsDir === "string" && path.isAbsolute(raw.modelsDir) ? path.normalize(raw.modelsDir) : d.modelsDir,
      llm: {
        contextSize:
          isPositiveInt(contextSize) && contextSize >= MIN_CONTEXT && contextSize <= MAX_CONTEXT
            ? contextSize
            : d.llm.contextSize,
        threads: isPositiveInt(llm.threads) ? llm.threads : null,
      },
      lastAgentId: typeof raw.lastAgentId === "string" && raw.lastAgentId ? raw.lastAgentId : d.lastAgentId,
      knowledgeBases: Array.isArray(raw.knowledgeBases) ? raw.knowledgeBases.filter(isKnowledgeBase) : [],
    };
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.config, null, 2);
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.filePath);
      });
    return this.writing;
  }
}
