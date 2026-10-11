// Recria os arquivos de desenvolvimento que não ficam no Git (modelo GGUF, Parquets da Wikipedia, modelo e5).
// Tudo vem do Hugging Face, com tamanho e SHA-256 conferidos; o que já existe e está íntegro é pulado.
//
//   npm run setup:dev                    # tudo
//   npm run setup:dev -- --only llm      # só o modelo de chat (dev-models/)
//   npm run setup:dev -- --only data     # só os Parquets (dev-data/)
//   npm run setup:dev -- --only embed    # só o modelo de embeddings (dev-data/embedding-models/)
//   npm run setup:dev -- --dry-run       # mostra o que baixaria, sem baixar
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDatasetDownloader } from "../electron/ingestion/dataset-downloader.ts";
import { listDatasetFiles, type DatasetFile } from "../electron/ingestion/hf-datasets.ts";
import { EmbeddingEngine } from "../electron/embeddings/embedding-engine.ts";
import { MODEL_CATALOG } from "../electron/models/catalog.ts";

const ROOT = path.join(import.meta.dirname, "..");
const MODELS_DIR = path.join(ROOT, "dev-models");
const DATA_DIR = path.join(ROOT, "dev-data");
const EMBED_CACHE = path.join(DATA_DIR, "embedding-models");

/** Recortes usados pelos scripts e pelos testes: o `simple` inteiro e o menor arquivo do `pt`. */
const SNAPSHOT = "20231101";
const DATASETS = [
  { language: "simple", file: "train-00000-of-00001.parquet", dest: "simple-20231101-00000.parquet" },
  { language: "pt", file: "train-00002-of-00006.parquet", dest: "pt-20231101-00002.parquet" },
];
/** O modelo de chat dos scripts (`rag:eval --answer`): o primeiro do catálogo do app. */
const LLM_ID = "qwen2.5-3b-instruct-q4_k_m";

const { values } = parseArgs({
  options: { only: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
const only = values.only;
if (only && !["llm", "data", "embed"].includes(only)) {
  console.error("uso: npm run setup:dev [-- --only llm|data|embed] [--dry-run]");
  process.exit(1);
}
const dryRun = values["dry-run"];

const MiB = 1024 ** 2;
const fmt = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / MiB).toFixed(0)} MiB`);

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Pula se o arquivo existe com o SHA-256 certo; senão baixa (retomando um `.part`, se houver). */
async function ensureFile(downloader: ReturnType<typeof createDatasetDownloader>, file: DatasetFile, dest: string) {
  const size = await stat(dest).then((s) => s.size).catch(() => null);
  if (size === file.size && (await sha256Of(dest)) === file.sha256) {
    console.log(`ok       ${path.relative(ROOT, dest)} (já existe, SHA-256 confere)`);
    return;
  }
  if (dryRun) {
    console.log(`baixaria ${path.relative(ROOT, dest)} (${fmt(file.size)})`);
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  let lastPrint = 0;
  await downloader.downloadFile(
    file,
    dest,
    (report) => {
      if (Date.now() - lastPrint < 2000) return;
      lastPrint = Date.now();
      const state = report.verifying ? "verificando" : `${((report.bytes / report.total) * 100).toFixed(0)}%`;
      console.log(`baixando ${path.basename(dest)} · ${state} · ${fmt(report.bytes)}/${fmt(report.total)}`);
    },
    new AbortController().signal,
  );
  console.log(`ok       ${path.relative(ROOT, dest)}`);
}

const downloader = createDatasetDownloader();
try {
  if (!only || only === "llm") {
    const model = MODEL_CATALOG.find((entry) => entry.id === LLM_ID);
    if (!model) throw new Error(`Modelo ${LLM_ID} não está no catálogo.`);
    const name = path.basename(model.downloadUrl);
    await ensureFile(downloader, { name, url: model.downloadUrl, size: model.sizeBytes, sha256: model.sha256 }, path.join(MODELS_DIR, name));
  }

  if (!only || only === "data") {
    for (const dataset of DATASETS) {
      const files = await listDatasetFiles(dataset.language, SNAPSHOT);
      const file = files.find((entry) => entry.name === dataset.file);
      if (!file) throw new Error(`O Hugging Face não lista ${dataset.file} em ${SNAPSHOT}.${dataset.language}.`);
      await ensureFile(downloader, file, path.join(DATA_DIR, dataset.dest));
    }
  }

  if (!only || only === "embed") {
    const engine = new EmbeddingEngine({ cacheDir: EMBED_CACHE });
    if (await engine.isInstalled()) {
      console.log(`ok       ${path.relative(ROOT, engine.modelDir)} (já instalado)`);
    } else if (dryRun) {
      console.log(`baixaria ${engine.modelId}@${engine.revision.slice(0, 7)} (~130 MiB)`);
    } else {
      let lastPrint = 0;
      await engine.install((progress) => {
        if (Date.now() - lastPrint < 2000) return;
        lastPrint = Date.now();
        console.log(`baixando ${progress.file} · ${fmt(progress.loaded)}/${fmt(progress.total)}`);
      });
      console.log(`ok       ${path.relative(ROOT, engine.modelDir)}`);
    }
    await engine.dispose();
  }
} finally {
  await downloader.shutdown();
}
console.log(dryRun ? "\nSimulação concluída (nada foi baixado)." : "\nAmbiente de desenvolvimento pronto.");
