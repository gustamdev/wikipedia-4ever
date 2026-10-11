// RagEngine com dependências falsas: threshold, fontes = trechos do prompt, orçamento de tokens com
// trechos longos e histórico grande, "não encontrei" sem chamar o modelo, cancelamento.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchResult } from "../../shared/chunk";
import type { ChatMessage } from "../../shared/electron-api";
import { DEFAULT_RAG_PARAMS, type RagParams } from "../../shared/rag.ts";
import { NO_CONTEXT } from "../agents/prompts.ts";
import { normalizeQuestion, RagEngine, type RagDeps } from "./rag-engine.ts";

function result(n: number, score: number, textLength = 200): SearchResult {
  return {
    chunk_id: `wikipedia:pt:${n}:0000`,
    document_id: String(n),
    document_title: `Artigo ${n}`,
    section: n % 2 ? "História" : null,
    text: `Trecho ${n}. ${"palavra ".repeat(Math.ceil(textLength / 8))}`.slice(0, textLength),
    language: "pt",
    source: "wikipedia",
    dataset_version: "20231101",
    url: `https://pt.wikipedia.org/wiki?curid=${n}`,
    score,
  };
}

/** Tokenizer falso: 1 token a cada 4 caracteres + 4 por mensagem (template) + 3 do início da resposta. */
const fakeCount = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 3);

function harness(options: { results: SearchResult[]; contextSize?: number; params?: Partial<RagParams> }) {
  const generated: ChatMessage[][] = [];
  const logs: string[] = [];
  const deps: RagDeps = {
    embedQuery: async () => [1, 0, 0],
    search: async (_vector, topK) => options.results.slice(0, topK),
    countPromptTokens: async (messages) => fakeCount(messages),
    countTextTokens: async (text) => Math.ceil(text.length / 4),
    contextSize: async () => options.contextSize ?? 4096,
    generate: async ({ messages, onTextChunk }) => {
      generated.push(messages);
      onTextChunk("Resposta [1].");
      return { text: "Resposta [1].", canceled: false };
    },
    locale: () => "pt-BR",
    params: () => ({ ...DEFAULT_RAG_PARAMS, minScore: 0.8, ...options.params }),
    log: (line) => logs.push(line),
  };
  return { engine: new RagEngine(deps), generated, logs };
}

const ask = (engine: RagEngine, question: string, messages: ChatMessage[] = [], signal = new AbortController().signal) => {
  const tokens: string[] = [];
  return engine.answer({ messages, question, signal, onToken: (t) => tokens.push(t) }).then((a) => ({ ...a, streamed: tokens.join("") }));
};

test("normalizeQuestion: colapsa espaços e quebras", () => {
  assert.equal(normalizeQuestion("  Quem   foi\n\nEinstein?  "), "Quem foi Einstein?");
});

test("score mínimo filtra; fontes = exatamente os trechos do prompt, em ordem de score", async () => {
  const h = harness({ results: [result(1, 0.86), result(2, 0.91), result(3, 0.79), result(4, 0.83)] });
  const answer = await ask(h.engine, "Quem foi o Artigo 2?");
  assert.equal(answer.noContext, false);
  assert.deepEqual(
    answer.sources.map((s) => s.chunk_id),
    ["wikipedia:pt:2:0000", "wikipedia:pt:1:0000", "wikipedia:pt:4:0000"],
  );
  const [messages] = h.generated;
  assert.equal(messages[0].role, "system");
  const user = messages.at(-1)!.content;
  // Cada fonte [n] está no prompt com o mesmo número; o trecho abaixo do score não está.
  answer.sources.forEach((source, i) => assert.ok(user.includes(`[${i + 1}] ${source.document_title}`), source.chunk_id));
  assert.ok(!user.includes("Trecho 3."), "abaixo do score não entra");
  assert.equal(answer.promptVersion, "rag-system@1+rag-context@1");
  assert.ok(h.logs.some((l) => l.includes("fontes wikipedia:pt:2:0000, wikipedia:pt:1:0000, wikipedia:pt:4:0000")), "ids logados");
});

test("nada acima do score: resposta fixa de 'não encontrei', sem chamar o modelo", async () => {
  const h = harness({ results: [result(1, 0.78), result(2, 0.7)] });
  const answer = await ask(h.engine, "Quem é Zorbax de Pluto?");
  assert.equal(answer.noContext, true);
  assert.equal(answer.text, NO_CONTEXT.build("pt-BR"));
  assert.equal(answer.streamed, answer.text, "o texto também vai por streaming");
  assert.deepEqual(answer.sources, []);
  assert.equal(answer.promptVersion, "no-context@1");
  assert.equal(h.generated.length, 0);
});

test("orçamento: trechos longos e histórico enorme nunca passam de contextSize − reserva", async () => {
  // 8 trechos de ~2.000 caracteres (~500 tokens) e 60 mensagens de ~1.200 caracteres de histórico.
  const results = Array.from({ length: 8 }, (_, i) => result(i + 1, 0.9 - i * 0.005, 2000));
  const history: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `mensagem ${i} ${"x".repeat(1200)}`,
  }));
  for (const contextSize of [4096, 2048, 8192]) {
    const h = harness({ results, contextSize });
    const answer = await ask(h.engine, "Pergunta?", history);
    const prompt = h.generated[0];
    const total = fakeCount(prompt);
    const limit = contextSize - DEFAULT_RAG_PARAMS.answerReserveTokens;
    assert.ok(total <= limit, `${contextSize}: ${total} > ${limit}`);
    assert.equal(answer.tokens?.total, total, "o total reportado é o do prompt enviado");
    assert.ok(answer.tokens!.context <= Math.floor(contextSize * DEFAULT_RAG_PARAMS.contextBudgetRatio), "trechos dentro da fração");
    assert.ok(answer.sources.length >= 1 && answer.sources.length <= DEFAULT_RAG_PARAMS.maxContextChunks);
    // Histórico: corta o mais antigo; o que fica é contíguo, termina na mensagem mais nova e começa numa pergunta.
    const kept = prompt.slice(1, -1);
    if (kept.length > 0) {
      assert.equal(kept[0].role, "user");
      assert.equal(kept.at(-1)!.content, history.at(-1)!.content);
      assert.deepEqual(kept, history.slice(history.length - kept.length));
    }
    assert.ok(answer.tokens!.base + answer.tokens!.context + answer.tokens!.history === total, "partes somam o total");
  }
});

test("maxContextChunks limita mesmo com orçamento sobrando", async () => {
  const h = harness({ results: Array.from({ length: 8 }, (_, i) => result(i + 1, 0.95 - i * 0.01)), params: { maxContextChunks: 3 } });
  const answer = await ask(h.engine, "Pergunta?");
  assert.equal(answer.sources.length, 3);
  assert.equal(answer.retrieved.length, 8, "o log mantém tudo o que passou do score");
});

test("contexto pequeno demais para qualquer trecho → 'não encontrei' em vez de prompt estourado", async () => {
  const h = harness({ results: [result(1, 0.9, 4000)], contextSize: 1024 });
  const answer = await ask(h.engine, "Pergunta?");
  assert.equal(answer.noContext, true);
  assert.equal(h.generated.length, 0);
});

test("cancelado antes de gerar: nada é gerado", async () => {
  const h = harness({ results: [result(1, 0.9)] });
  const controller = new AbortController();
  controller.abort();
  const answer = await ask(h.engine, "Pergunta?", [], controller.signal);
  assert.equal(answer.canceled, true);
  assert.equal(h.generated.length, 0);
});
