// EmbeddingEngine com pipeline falso (prefixos, lotes, instalação, offline) + cosineSimilarity.
// Teste real opcional: W4E_EMBED_CACHE=<pasta com o modelo instalado> npm test
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cosineSimilarity, norm } from "../../shared/vector-math.ts";
import {
  EMBEDDING_MODEL_NOT_INSTALLED,
  EmbeddingEngine,
  type CreateExtractorOptions,
  type FeatureExtractor,
} from "./embedding-engine.ts";

const DIMS = 4;

/** Pipeline falso: grava os textos recebidos e, na instalação, "baixa" arquivos para o cache. */
function fakeFactory(log: { texts: string[][]; creates: CreateExtractorOptions[] }) {
  return async (options: CreateExtractorOptions): Promise<FeatureExtractor> => {
    log.creates.push(options);
    if (options.allowRemote) {
      const dir = path.join(options.cacheDir, ...options.modelId.split("/"), options.revision);
      await mkdir(path.join(dir, "onnx"), { recursive: true });
      await writeFile(path.join(dir, "config.json"), "{}");
      await writeFile(path.join(dir, "onnx", "model_quantized.onnx"), Buffer.alloc(1024));
      options.onProgress?.({ file: "onnx/model_quantized.onnx", loaded: 1024, total: 1024 });
    }
    const extractor = async (texts: string[]) => {
      log.texts.push(texts);
      return { tolist: () => texts.map((_, i) => Array.from({ length: DIMS }, (__, j) => (i + j) % 2)) };
    };
    return Object.assign(extractor, { dispose: async () => undefined });
  };
}

describe("EmbeddingEngine (pipeline falso)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "w4e embeddings-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("sem instalar: erro EMBEDDING_MODEL_NOT_INSTALLED e nenhum acesso à rede", async () => {
    const log = { texts: [], creates: [] as CreateExtractorOptions[] };
    const engine = new EmbeddingEngine({ cacheDir: path.join(dir, "vazio"), dimensions: DIMS, createExtractor: fakeFactory(log) });
    assert.equal(await engine.isInstalled(), false);
    await assert.rejects(engine.embed(["x"], "query"), new RegExp(EMBEDDING_MODEL_NOT_INSTALLED));
    assert.equal(log.creates.length, 0, "não tentou baixar sozinho");
  });

  test("install → marcador; load posterior só do disco; prefixos query/passage", async () => {
    const cacheDir = path.join(dir, "cache");
    const log = { texts: [] as string[][], creates: [] as CreateExtractorOptions[] };
    const progress: string[] = [];
    const engine = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: fakeFactory(log) });
    await engine.install((p) => progress.push(p.file));
    assert.deepEqual(progress, ["onnx/model_quantized.onnx"]);
    const status = await engine.status();
    assert.equal(status.installed, true);
    assert.equal(status.sizeBytes, 1026);

    // Novo processo (engine novo): carrega com allowRemote=false.
    const offline = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: fakeFactory(log) });
    const [q] = await offline.embed(["Quem foi Einstein?"], "query");
    await offline.embed(["Einstein foi um físico.", "Outro texto"], "passage");
    assert.equal(log.creates.at(-1)?.allowRemote, false);
    assert.equal(q.length, DIMS);
    assert.deepEqual(log.texts.slice(-2), [["query: Quem foi Einstein?"], ["passage: Einstein foi um físico.", "passage: Outro texto"]]);
    await offline.load();
    assert.equal(log.creates.filter((c) => !c.allowRemote).length, 1, "load é idempotente");
  });

  test("lotes de 32, ordem preservada", async () => {
    const cacheDir = path.join(dir, "cache");
    const log = { texts: [] as string[][], creates: [] as CreateExtractorOptions[] };
    const engine = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: fakeFactory(log) });
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const vectors = await engine.embed(texts, "passage");
    assert.equal(vectors.length, 70);
    assert.deepEqual(log.texts.map((b) => b.length), [32, 32, 6]);
    assert.equal(log.texts[2][5], "passage: t69");
  });

  test("countTokens: conta com o prefixo do modo; null sem tokenizer", async () => {
    const cacheDir = path.join(dir, "cache");
    const withTokenizer = async (options: CreateExtractorOptions) => {
      const extractor = await fakeFactory({ texts: [], creates: [] })(options);
      // Um "token" por palavra, mais 2 especiais.
      return Object.assign(extractor, { tokenizer: { encode: (t: string) => [0, ...t.split(" ").map(() => 1), 0] } });
    };
    const engine = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: withTokenizer });
    assert.deepEqual(await engine.countTokens(["a b c", "d"], "passage"), [6, 4]);
    const plain = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: fakeFactory({ texts: [], creates: [] }) });
    assert.equal(await plain.countTokens(["a"], "query"), null);
  });

  test("arquivo truncado depois da instalação → não instalado", async () => {
    const cacheDir = path.join(dir, "truncado");
    const log = { texts: [], creates: [] as CreateExtractorOptions[] };
    const engine = new EmbeddingEngine({ cacheDir, dimensions: DIMS, createExtractor: fakeFactory(log) });
    await engine.install(() => undefined);
    await truncate(path.join(engine.modelDir, "onnx", "model_quantized.onnx"), 10);
    assert.equal(await engine.isInstalled(), false);
  });

  test("dispose: recusa trabalho novo", async () => {
    const engine = new EmbeddingEngine({ cacheDir: path.join(dir, "cache"), dimensions: DIMS, createExtractor: fakeFactory({ texts: [], creates: [] }) });
    await engine.load();
    await engine.dispose();
    await assert.rejects(engine.embed(["x"], "query"), /encerrado/);
  });
});

test("cosineSimilarity: idênticos 1, ortogonais 0, opostos -1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-12);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, "vetor nulo → 0, não NaN");
  assert.throws(() => cosineSimilarity([1], [1, 2]), /Dimensões/);
});

// Modelo real (opcional): pasta com o modelo já instalado pelo app ou pelo script de verificação.
const realCache = process.env.W4E_EMBED_CACHE;
test("modelo real: 384 dimensões, norma ≈ 1, prefixos aplicados", { skip: !realCache && "defina W4E_EMBED_CACHE" }, async () => {
  const engine = new EmbeddingEngine({ cacheDir: realCache! });
  assert.equal(await engine.isInstalled(), true, "modelo instalado na pasta indicada");
  const [v] = await engine.embed(["x"], "passage");
  assert.equal(v.length, 384);
  assert.ok(Math.abs(norm(v) - 1) < 1e-3, `norma ${norm(v)}`);
  const [q, high, low] = [
    ...(await engine.embed(["Qual a capital da França?"], "query")),
    ...(await engine.embed(["Paris é a capital e maior cidade da França", "O futebol é o esporte mais popular do Brasil"], "passage")),
  ];
  assert.ok(cosineSimilarity(q, high) > cosineSimilarity(q, low));
  await engine.dispose();
});
