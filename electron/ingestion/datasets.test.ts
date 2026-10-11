// Listagem do Hugging Face (com `fetch` falso) e estimativa de espaço.
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateIngestion } from "./estimate.ts";
import { assertDatasetId, listDatasetFiles, listLanguages } from "./hf-datasets.ts";

function fakeFetch(pages: Record<string, { body: unknown; link?: string; status?: number }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const page = pages[String(input)];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: page.link ? { link: page.link } : {},
    });
  }) as typeof fetch;
}

const ROOT = "https://huggingface.co/api/datasets/wikimedia/wikipedia/tree/main";

test("listLanguages: só diretórios do snapshot, em ordem, seguindo a paginação", async () => {
  const f = fakeFetch({
    [ROOT]: {
      body: [
        { type: "directory", path: "20231101.pt" },
        { type: "file", path: "README.md" },
        { type: "directory", path: "20231101.ab" },
        { type: "directory", path: "20230601.xx" },
      ],
      link: `<${ROOT}?cursor=2>; rel="next"`,
    },
    [`${ROOT}?cursor=2`]: { body: [{ type: "directory", path: "20231101.zh-min-nan" }] },
  });
  const languages = await listLanguages("20231101", f);
  assert.deepEqual(languages.map((l) => l.code), ["ab", "pt", "zh-min-nan"]);
});

test("listDatasetFiles: tamanho e SHA-256 do LFS, URL de download, ordem por nome", async () => {
  const dir = `${ROOT}/20231101.pt`;
  const f = fakeFetch({
    [dir]: {
      body: [
        { type: "file", path: "20231101.pt/train-00001-of-00002.parquet", size: 134, lfs: { oid: "b".repeat(64), size: 200 } },
        { type: "file", path: "20231101.pt/train-00000-of-00002.parquet", size: 134, lfs: { oid: "a".repeat(64), size: 100 } },
        { type: "file", path: "20231101.pt/.gitattributes", size: 5 },
      ],
    },
  });
  const files = await listDatasetFiles("pt", "20231101", f);
  assert.deepEqual(files.map((x) => [x.name, x.size, x.sha256[0]]), [
    ["train-00000-of-00002.parquet", 100, "a"],
    ["train-00001-of-00002.parquet", 200, "b"],
  ]);
  assert.equal(files[0].url, "https://huggingface.co/datasets/wikimedia/wikipedia/resolve/main/20231101.pt/train-00000-of-00002.parquet");
});

test("listDatasetFiles: erro de HTTP e idioma sem dados viram mensagens claras", async () => {
  await assert.rejects(listDatasetFiles("pt", "20231101", fakeFetch({})), /HTTP 404/);
  await assert.rejects(listDatasetFiles("zz", "20231101", fakeFetch({ [`${ROOT}/20231101.zz`]: { body: [] } })), /Não há dados/);
});

test("assertDatasetId recusa o que não pode ir para URL/caminho", () => {
  for (const bad of ["", "../x", "pt/../..", "a b", "pt\\x", "-x", "x".repeat(41)]) {
    assert.throws(() => assertDatasetId(bad, "20231101"), /idioma/i, bad);
  }
  assert.throws(() => assertDatasetId("pt", "latest"), /Snapshot/);
  assert.doesNotThrow(() => assertDatasetId("zh-min-nan", "20231101"));
});

test("estimateIngestion: soma exata dos arquivos, desconta o já baixado, bloqueia sem espaço", () => {
  const files = [
    { name: "a.parquet", url: "u", size: 100_000_000, sha256: "a" },
    { name: "b.parquet", url: "u", size: 50_000_000, sha256: "b" },
  ];
  const base = { language: "pt", snapshot: "20231101", files, presentBytes: new Map<string, number>() };
  const free = estimateIngestion({ ...base, freeBytes: 1e12 });
  assert.equal(free.rawBytes, 150_000_000);
  assert.equal(free.estimateBasis, "measured");
  assert.equal(free.totalBytes, free.rawBytes + free.estimatedVectorBytes + free.estimatedIndexBytes);
  assert.ok(free.sufficient);

  const partial = estimateIngestion({ ...base, presentBytes: new Map([["a.parquet", 100_000_000], ["b.parquet", 999]]), freeBytes: 1e12 });
  assert.equal(partial.alreadyDownloadedBytes, 100_000_999);
  assert.equal(partial.totalBytes, free.totalBytes - 100_000_999);

  const tight = estimateIngestion({ ...base, freeBytes: free.totalBytes - 1 });
  assert.equal(tight.sufficient, false);
  assert.equal(estimateIngestion({ ...base, language: "ja", freeBytes: 1e12 }).estimateBasis, "rough");
});
