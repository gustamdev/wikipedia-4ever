// Chunker com textos sintéticos no formato observado no dataset wikimedia/wikipedia:
// títulos como linhas soltas (às vezes com espaço no fim), itens de lista começando com espaço,
// apêndices e linhas de categoria no fim.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkArticle,
  defaultEstimateTokens,
  dropSectionsFor,
  learnAppendixTitles,
  splitSections,
  splitSentences,
  type ChunkerOptions,
} from "./chunker.ts";
import type { WikiArticle } from "./parquet-reader.ts";

const META = { language: "pt", source: "wikipedia", dataset_version: "20231101" } as const;
const OPTS: ChunkerOptions = { maxTokens: 120, minTokens: 20, overlapSentences: 1 };

const sentence = (topic: string, i: number) => `A frase número ${i} fala sobre ${topic} com alguns detalhes adicionais.`;
const paragraph = (topic: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => sentence(topic, from + i)).join(" ");

function article(text: string): WikiArticle {
  return { id: "123", url: "https://pt.wikipedia.org/wiki/Teste", title: "Teste", text };
}

const ARTICLE = [
  paragraph("a introdução", 3),
  "",
  "História ",
  "",
  paragraph("a história", 4),
  "",
  paragraph("a história depois", 2, 10),
  "",
  "Geografia",
  paragraph("a geografia", 3),
  "",
  "Principais cidades",
  " Lisboa",
  " Porto",
  " Coimbra",
  "",
  "Ver também",
  "",
  " Outro artigo",
  "",
  "Referências",
  "",
  "Categoria solta",
].join("\n");

test("introdução sem seção, seções detectadas, lista não vira título, apêndices descartados", () => {
  const sections = splitSections(ARTICLE, ["Ver também", "Referências"]);
  assert.deepEqual(sections.map((s) => s.title), [null, "História", "Geografia", "Principais cidades"]);
  assert.equal(sections[3].paragraphs[0], "Lisboa\nPorto\nCoimbra", "itens de lista ficam juntos num parágrafo");
  const chunks = chunkArticle(article(ARTICLE), META, OPTS);
  assert.equal(chunks[0].section, null);
  assert.ok(chunks.every((c) => !/Outro artigo|Categoria solta|Ver também|Referências/.test(c.text)));
  assert.ok(!chunks.some((c) => c.section === "Ver também"));
});

test("metadados completos, ids determinísticos e sequenciais", () => {
  const a = chunkArticle(article(ARTICLE), META, OPTS);
  const b = chunkArticle(article(ARTICLE), META, OPTS);
  assert.deepEqual(a, b, "determinística");
  a.forEach((c, i) => {
    assert.equal(c.chunk_id, `wikipedia:pt:123:${String(i).padStart(4, "0")}`);
    assert.equal(c.document_id, "123");
    assert.equal(c.document_title, "Teste");
    assert.equal(c.url, "https://pt.wikipedia.org/wiki/Teste");
    assert.equal(c.dataset_version, "20231101");
    assert.ok(c.text.trim());
  });
});

test("parágrafo gigante: dividido por frases, nunca no meio da frase; respeita maxTokens + overlap", () => {
  const giant = paragraph("um assunto enorme", 30);
  const chunks = chunkArticle(article(giant), META, OPTS);
  assert.ok(chunks.length > 3);
  const sentences = new Set(splitSentences(giant));
  for (const c of chunks) {
    for (const s of splitSentences(c.text)) assert.ok(sentences.has(s), `frase cortada: "${s}"`);
    assert.ok(defaultEstimateTokens(c.text) <= OPTS.maxTokens + 30, `chunk grande demais: ${defaultEstimateTokens(c.text)}`);
  }
});

test("frase gigante sem pontuação: último recurso por palavras", () => {
  const words = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(" ");
  const chunks = chunkArticle(article(words), META, { ...OPTS, overlapSentences: 0 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((c) => c.text).join(" "), words, "nenhuma palavra perdida ou cortada");
  for (const c of chunks) assert.ok(defaultEstimateTokens(c.text) <= OPTS.maxTokens);
});

test("overlap: última frase do chunk anterior da MESMA seção; nunca atravessa seções", () => {
  const text = [paragraph("física", 12), "", "Outra seção", "", paragraph("química", 12)].join("\n");
  const chunks = chunkArticle(article(text), META, OPTS);
  const fisica = chunks.filter((c) => c.section === null);
  const quimica = chunks.filter((c) => c.section === "Outra seção");
  assert.ok(fisica.length >= 2 && quimica.length >= 2);
  const lastOfPrevious = splitSentences(fisica[0].text).at(-1)!;
  assert.ok(fisica[1].text.startsWith(lastOfPrevious), "overlap dentro da seção");
  assert.ok(!quimica[0].text.includes("física"), "overlap não atravessa seção");
  assert.ok(!chunks.some((c) => c.text.includes("física") && c.text.includes("química")), "seções nunca se misturam");
});

test("subseção logo abaixo do título vira rótulo composto", () => {
  const text = ["Intro qualquer com texto suficiente.", "", "História", "", "Origem ", "", paragraph("a origem", 2)].join("\n");
  assert.deepEqual(splitSections(text, []).map((s) => s.title), [null, "História › Origem"]);
});

test("chunk pequeno é fundido ao vizinho da mesma seção", () => {
  const text = [paragraph("x", 8), "", "Curto."].join("\n");
  const chunks = chunkArticle(article(text), META, { maxTokens: 200, minTokens: 50, overlapSentences: 0 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.endsWith("Curto."));
});

test("vazio, só apêndice ou só categorias → []", () => {
  assert.deepEqual(chunkArticle(article(""), META, OPTS), []);
  assert.deepEqual(chunkArticle(article("Referências\n\n Livro X\n"), META, OPTS), []);
  assert.deepEqual(chunkArticle(article("Hynobiidae\nAnfíbios descritos em 1870"), META, OPTS), []);
});

test("\\r\\n, espaços múltiplos e restos de tabela são normalizados", () => {
  const text = "Primeira   frase\tdo texto com espaços.\r\n\r\n{|\r\n|-\r\n|}\r\nSegunda frase do texto aqui.";
  const [c] = chunkArticle(article(text), META, OPTS);
  assert.equal(c.text, "Primeira frase do texto com espaços.\n\nSegunda frase do texto aqui.");
});

test("restos de wikitext: infobox multilinha, aninhada e linhas de tabela", () => {
  const text = [
    "{{Info/Tenista ",
    "|foto = ",
    "|nome = {{Bandeira|EUA}} Fulano",
    "}}",
    "Fulano foi um tenista ''americano'' muito '''conhecido'''.",
    "",
    "Resultados",
    "",
    "|align=\"left\"|1ª",
    "Ele venceu vários torneios importantes. {{Sem fechamento",
  ].join("\n");
  const chunks = chunkArticle(article(text), META, { ...OPTS, minTokens: 1 });
  assert.equal(chunks[0].text, "Fulano foi um tenista americano muito conhecido.");
  assert.equal(chunks[1].section, "Resultados");
  assert.equal(chunks[1].text, "Ele venceu vários torneios importantes. {{Sem fechamento", "desbalanceado fica");
});

test("splitSentences: abreviações e iniciais não cortam", () => {
  assert.deepEqual(splitSentences("O Dr. Silva chegou. Depois J. R. R. Tolkien escreveu. Fim!"), [
    "O Dr. Silva chegou.",
    "Depois J. R. R. Tolkien escreveu.",
    "Fim!",
  ]);
});

test("opções inválidas", () => {
  assert.throws(() => chunkArticle(article("x"), META, { ...OPTS, maxTokens: 600 }), /maxTokens/);
  assert.throws(() => chunkArticle(article("x"), META, { ...OPTS, minTokens: 200 }), /minTokens/);
});

// ---- qualquer idioma ---------------------------------------------------------------------------

test("frases em escritas sem espaço/sem maiúscula: chinês, árabe, hindi", () => {
  assert.deepEqual(splitSentences("北京是中国的首都。它有很多历史建筑！你去过吗？", "zh"), ["北京是中国的首都。", "它有很多历史建筑！", "你去过吗？"]);
  assert.deepEqual(splitSentences("القاهرة هي عاصمة مصر. هل زرتها؟ نعم.", "ar"), ["القاهرة هي عاصمة مصر.", "هل زرتها؟", "نعم."]);
  assert.deepEqual(splitSentences("दिल्ली भारत की राजधानी है। यह बड़ा शहर है।", "hi"), ["दिल्ली भारत की राजधानी है।", "यह बड़ा शहर है।"]);
});

test("tag de idioma do dataset inválida para o ICU (zh-min-nan) não quebra", () => {
  assert.deepEqual(splitSentences("Tâi-oân sī chi̍t ê tó. Í-keng chin kú.", "zh-min-nan").length, 2);
  const [c] = chunkArticle(article("Tâi-oân sī chi̍t ê tó."), { ...META, language: "zh-min-nan" }, OPTS);
  assert.equal(c.chunk_id, "wikipedia:zh-min-nan:123:0000");
});

test("estimativa por escrita: CJK conta bem mais por caractere que o latim", () => {
  assert.equal(defaultEstimateTokens("北京是中国的首都"), 6); // 8 × 0,75
  assert.equal(defaultEstimateTokens("abcdefg"), 2); // 7 / 3,5
  assert.ok(defaultEstimateTokens("这座城市由葡萄牙殖民者于十六世纪建立") > "这座城市由葡萄牙殖民者于十六世纪建立".length / 2);
});

test("chinês: parágrafo gigante sem espaços vira chunks dentro do limite, sem perder texto, sem espaço entre frases", () => {
  const zh = Array.from({ length: 60 }, (_, i) => `这是第${i}个句子，介绍城市的历史和文化。`).join("");
  const chunks = chunkArticle(article(zh), { ...META, language: "zh" }, { ...OPTS, overlapSentences: 0 });
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(defaultEstimateTokens(c.text) <= OPTS.maxTokens, `${defaultEstimateTokens(c.text)}`);
  assert.equal(chunks.map((c) => c.text).join(""), zh, "texto íntegro e sem espaços inseridos");
});

test("chinês: frase única gigante → fatias pela segmentação de palavras", () => {
  const zh = "这座城市由葡萄牙殖民者于十六世纪建立后来成为该地区重要的商业中心".repeat(30);
  const chunks = chunkArticle(article(zh), { ...META, language: "zh" }, { ...OPTS, overlapSentences: 0 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((c) => c.text).join(""), zh);
  for (const c of chunks) assert.ok(defaultEstimateTokens(c.text) <= OPTS.maxTokens);
});

test("títulos: linha com pontuação final CJK não é título; título CJK é", () => {
  const text = ["东京是日本的首都，人口很多。", "", "历史", "", "东京原名江户。", "", "这一行很短。", "", "经济", "东京是重要的经济中心。"].join("\n");
  assert.deepEqual(splitSections(text, []).map((s) => s.title), [null, "历史", "经济"]);
});

test("learnAppendixTitles: acha apêndices frequentes no fim sem prosa; ignora seção de conteúdo", () => {
  const prose = "Este é um parágrafo de prosa com tamanho suficiente para contar como texto corrido de verdade. Ele tem frases completas.";
  const texts = Array.from({ length: 100 }, (_, i) =>
    [
      prose,
      "",
      "História",
      "",
      prose,
      ...(i % 3 === 0 ? ["", "Discografia", "", " Álbum A", " Álbum B", "", "Mais prosa", "", prose] : []),
      "",
      "Muat juga",
      "",
      " Artigo relacionado",
      "",
      "Pranala luar",
      "",
      " Sítio oficial",
    ].join("\n"),
  );
  const learned = learnAppendixTitles(texts);
  assert.deepEqual(learned, ["Muat juga", "Pranala luar"]);
  const chunks = chunkArticle(article(texts[0]), { ...META, language: "id" }, { ...OPTS, dropSections: dropSectionsFor("id", learned) });
  assert.ok(chunks.some((c) => c.section === "Discografia"), "conteúdo no meio do artigo fica");
  assert.ok(!chunks.some((c) => /Sítio oficial|Artigo relacionado/.test(c.text)));
});
