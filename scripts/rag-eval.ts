// Avaliação do RAG fora do Electron, com os componentes reais (e5, LanceDB, node-llama-cpp).
//
//   Calibrar o score mínimo (só embed + busca; rápido):
//     node scripts/rag-eval.ts --calibrate --vectordb <dir> --embed-cache <dir> [--questions arquivo.json]
//   Respostas completas (RagEngine + modelo local):
//     node scripts/rag-eval.ts --answer --vectordb <dir> --embed-cache <dir> --model <arquivo.gguf> [--min-score 0.82] [--questions arquivo.json]
//
// `--questions`: JSON `{ "inside": string[], "outside": string[] }` (perguntas que a base cobre e que não cobre).
// Sem ele, usa o conjunto padrão abaixo, escrito para o recorte do `simple` indexado na Semana 8.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RAG_PARAMS } from "../shared/rag.ts";
import { E5_DIMENSIONS, E5_MODEL_ID, EmbeddingEngine } from "../electron/embeddings/embedding-engine.ts";
import { LlmRuntime } from "../electron/llm/runtime.ts";
import { RagEngine } from "../electron/rag/rag-engine.ts";
import { LanceVectorStore } from "../electron/vector/vector-store.ts";

const DEFAULT_QUESTIONS = {
  inside: [
    "Who was Alan Turing?",
    "Qual é a capital da Austrália?",
    "What is the largest planet in the Solar System?",
    "Onde fica Honolulu?",
    "What is an asteroid?",
    "Quem criou o Esperanto?",
    "How many days does February have in a leap year?",
    "Qual é o símbolo químico do zinco?",
    "What do beekeepers do?",
    "Em que ano começou a Guerra Fria?",
  ],
  outside: [
    "Quem é Zorbax de Pluto?",
    "What is the population of the city of Quentaria?",
    "Quem venceu a Copa do Mundo de 2014?",
    "How do I bake sourdough bread?",
    "Qual é o enredo do filme Titanic?",
    "Qual a fórmula química da cafeína?",
    "Who is the lead singer of the band Glorpstar?",
    "Quem foi o primeiro presidente do Brasil?",
  ],
};

const { values } = parseArgs({
  options: {
    calibrate: { type: "boolean", default: false },
    answer: { type: "boolean", default: false },
    vectordb: { type: "string" },
    "embed-cache": { type: "string" },
    model: { type: "string" },
    questions: { type: "string" },
    "min-score": { type: "string" },
    "context-size": { type: "string", default: "4096" },
  },
});
if (!values.vectordb || !values["embed-cache"] || values.calibrate === values.answer || (values.answer && !values.model)) {
  console.error("uso: veja o cabeçalho de scripts/rag-eval.ts");
  process.exit(1);
}

const questions: typeof DEFAULT_QUESTIONS = values.questions
  ? JSON.parse(await readFile(values.questions, "utf8"))
  : DEFAULT_QUESTIONS;
const embeddings = new EmbeddingEngine({ cacheDir: path.resolve(values["embed-cache"]) });
const store = new LanceVectorStore({ dir: path.resolve(values.vectordb), embeddingModel: E5_MODEL_ID, dimensions: E5_DIMENSIONS });
const embedQuery = async (text: string) => (await embeddings.embed([text], "query"))[0];
const search = (vector: number[], topK: number) => store.search(vector, topK, { source: "wikipedia" });
console.log(`base: ${JSON.stringify(await store.getInfo())}`);

if (values.calibrate) {
  const tops: Record<"inside" | "outside", number[]> = { inside: [], outside: [] };
  for (const group of ["inside", "outside"] as const) {
    console.log(`\n== ${group === "inside" ? "dentro da base" : "fora da base"}`);
    for (const q of questions[group]) {
      const results = await search(await embedQuery(q), DEFAULT_RAG_PARAMS.topK);
      const top = results[0];
      tops[group].push(top?.score ?? 0);
      console.log(
        `${(top?.score ?? 0).toFixed(4)}  ${q}  →  ${top ? `${top.document_title}${top.section ? ` — ${top.section}` : ""}` : "—"}` +
          `   (top-${results.length}: ${results.map((r) => r.score.toFixed(3)).join(" ")})`,
      );
    }
  }
  const minInside = Math.min(...tops.inside);
  const maxOutside = Math.max(...tops.outside);
  console.log(`\nmenor top-1 dentro: ${minInside.toFixed(4)} · maior top-1 fora: ${maxOutside.toFixed(4)}`);
  console.log(
    minInside > maxOutside
      ? `separáveis: qualquer limiar entre ${maxOutside.toFixed(4)} e ${minInside.toFixed(4)} (meio: ${((minInside + maxOutside) / 2).toFixed(4)})`
      : "não separáveis só pelo top-1: há pergunta de fora com score maior que alguma de dentro",
  );
} else {
  const runtime = new LlmRuntime();
  await runtime.load({ modelPath: path.resolve(values.model!), contextSize: Number(values["context-size"]) });
  const minScore = values["min-score"] ? Number(values["min-score"]) : DEFAULT_RAG_PARAMS.minScore;
  const rag = new RagEngine({
    embedQuery,
    search,
    countPromptTokens: (m) => runtime.countPromptTokens(m),
    countTextTokens: (t) => runtime.countTextTokens(t),
    contextSize: () => runtime.contextSize(),
    generate: (o) => runtime.generate(o),
    locale: () => "pt-BR",
    params: () => ({ ...DEFAULT_RAG_PARAMS, minScore }),
  });
  for (const group of ["inside", "outside"] as const) {
    for (const q of questions[group]) {
      const a = await rag.answer({ messages: [], question: q, signal: new AbortController().signal, onToken: () => undefined });
      console.log(`\n### [${group === "inside" ? "dentro" : "fora"}] ${q}`);
      console.log(a.text.trim());
      console.log(
        a.noContext
          ? "fontes: nenhuma (resposta fixa, modelo não chamado)"
          : `fontes: ${a.sources.map((s, i) => `[${i + 1}] ${s.document_title}${s.section ? ` — ${s.section}` : ""} (${s.score.toFixed(3)})`).join(" · ")}`,
      );
      console.log(
        `tokens: ${a.tokens ? `${a.tokens.total}/${a.tokens.limit} (base ${a.tokens.base}, trechos ${a.tokens.context})` : "—"} · ` +
          `embed ${a.timings.embedMs} ms · busca ${a.timings.searchMs} ms · geração ${a.timings.generateMs} ms · ${a.timings.outputTokens} tokens de saída · ${a.promptVersion}`,
      );
    }
  }
  await runtime.dispose();
}
await embeddings.dispose();
await store.close();
