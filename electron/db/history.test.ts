// HistoryStore contra um arquivo SQLite real num diretório temporário (com espaço e acento no path).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { titleFromQuestion } from "../../shared/chat.ts";
import { HistoryStore, MIGRATIONS } from "./history.ts";

let dir: string;
let file: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "w4e histórico-"));
  file = path.join(dir, "history.sqlite");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("migrations: cria o schema atual e reabrir não reaplica", () => {
  const a = new HistoryStore(file);
  assert.equal(a.schemaVersion, MIGRATIONS.length);
  const conv = a.createConversation({ title: "persistente", agentId: "assistant" });
  a.close();
  const b = new HistoryStore(file);
  assert.equal(b.schemaVersion, MIGRATIONS.length);
  assert.equal(b.getConversation(conv.id)?.title, "persistente");
  b.close();
});

test("migration 2: banco da Semana 4 (v1) ganha as colunas do RAG sem perder mensagens", () => {
  const v1File = path.join(dir, "v1.sqlite");
  const raw = new Database(v1File);
  raw.exec(MIGRATIONS[0]);
  raw.pragma("user_version = 1");
  raw.prepare("INSERT INTO conversations VALUES ('c1', 'antiga', NULL, 'assistant', 1, 1)").run();
  raw.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'oi', 1)").run();
  raw.close();

  const store = new HistoryStore(v1File);
  assert.equal(store.schemaVersion, 2);
  const [old] = store.messages("c1");
  assert.equal(old.content, "oi");
  assert.equal(old.usedRag, false);
  assert.equal(old.sources, null);
  store.close();
});

test("fontes do RAG: gravadas e lidas de volta na ordem; JSON inválido vira null", () => {
  const store = new HistoryStore(file);
  const conv = store.createConversation({ title: "rag", agentId: "wikipedia" });
  const sources = [
    { chunk_id: "wikipedia:pt:1:0000", document_title: "Einstein", section: null, url: "https://pt.wikipedia.org/wiki?curid=1", text: "Físico.", score: 0.87 },
    { chunk_id: "wikipedia:pt:1:0002", document_title: "Einstein", section: "Vida", url: "https://pt.wikipedia.org/wiki?curid=1", text: "Nasceu em Ulm.", score: 0.84 },
  ];
  store.addMessage({ conversationId: conv.id, role: "assistant", content: "Foi físico [1].", promptVersion: "rag-system@1+rag-context@1", usedRag: true, sources });
  store.close();

  const reopened = new HistoryStore(file);
  const [message] = reopened.messages(conv.id);
  assert.equal(message.usedRag, true);
  assert.deepEqual(message.sources, sources, "fontes reaparecem ao reabrir");
  assert.equal(message.promptVersion, "rag-system@1+rag-context@1");
  reopened.close();

  const raw = new Database(file);
  raw.prepare("UPDATE messages SET sources_json = 'não é json' WHERE conversation_id = ?").run(conv.id);
  raw.close();
  const broken = new HistoryStore(file);
  assert.equal(broken.messages(conv.id)[0].sources, null);
  broken.close();
});

test("mensagens em ordem, touch atualiza updated_at e model_id", () => {
  const h = new HistoryStore(file);
  const conv = h.createConversation({ title: "ordem", agentId: "assistant" });
  const m1 = h.addMessage({ conversationId: conv.id, role: "user", content: "1" });
  const m2 = h.addMessage({ conversationId: conv.id, role: "assistant", content: "2", modelId: "qwen", promptVersion: "assistant-system@1" });
  const m3 = h.addMessage({ conversationId: conv.id, role: "user", content: "3" });
  assert.deepEqual(h.messages(conv.id).map((m) => m.id), [m1.id, m2.id, m3.id]);
  const updated = h.getConversation(conv.id)!;
  assert.ok(updated.updatedAt >= m3.createdAt);
  assert.equal(updated.modelId, "qwen", "model_id fica com o último modelo usado");
  assert.equal(h.messages(conv.id)[1].promptVersion, "assistant-system@1");
  assert.equal(h.listConversations()[0].id, conv.id, "mais recente primeiro");
  h.close();
});

test("renomear persiste; excluir remove as mensagens via ON DELETE CASCADE", () => {
  const h = new HistoryStore(file);
  const conv = h.createConversation({ title: "antes", agentId: "assistant" });
  h.addMessage({ conversationId: conv.id, role: "user", content: "x" });
  h.renameConversation(conv.id, "depois");
  h.close();

  const h2 = new HistoryStore(file);
  assert.equal(h2.getConversation(conv.id)?.title, "depois");
  assert.equal(h2.countMessages(conv.id), 1);
  h2.deleteConversation(conv.id);
  assert.equal(h2.getConversation(conv.id), undefined);
  assert.equal(h2.countMessages(conv.id), 0, "cascade apagou as mensagens");
  h2.close();
});

test("status e CHECK constraints", () => {
  const h = new HistoryStore(file);
  const conv = h.createConversation({ title: "status", agentId: "assistant" });
  h.addMessage({ conversationId: conv.id, role: "assistant", content: "parcial", status: "canceled" });
  assert.equal(h.messages(conv.id)[0].status, "canceled");
  assert.throws(() =>
    h.addMessage({ conversationId: conv.id, role: "hacker" as never, content: "x" }),
  /CHECK constraint failed/);
  assert.throws(() => h.addMessage({ conversationId: "nao-existe", role: "user", content: "x" }), /FOREIGN KEY/);
  h.close();
});

test("SQL vindo do usuário é só dado (prepared statements)", () => {
  const h = new HistoryStore(file);
  const evil = "x'); DROP TABLE messages; --";
  const conv = h.createConversation({ title: evil, agentId: "assistant" });
  h.addMessage({ conversationId: conv.id, role: "user", content: evil });
  assert.equal(h.getConversation(conv.id)?.title, evil);
  assert.equal(h.messages(conv.id)[0].content, evil);
  h.close();
});

test("titleFromQuestion: uma linha, ~40 caracteres", () => {
  assert.equal(titleFromQuestion("  Quem foi\n Santos   Dumont? "), "Quem foi Santos Dumont?");
  const long = titleFromQuestion("a".repeat(100));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
  assert.equal(titleFromQuestion("   "), "Nova conversa");
});
