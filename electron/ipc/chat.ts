// Conversas persistidas no SQLite + geração com streaming. O Main é a fonte da verdade:
// o histórico enviado ao modelo é sempre montado a partir do banco.
import { app, BrowserWindow, clipboard, ipcMain, shell, type WebContents } from "electron";
import path from "node:path";
import type { ChatMessage } from "../../shared/electron-api";
import { DEFAULT_CONVERSATION_TITLE, titleFromQuestion, type Conversation, type Message } from "../../shared/chat";
import { DEFAULT_AGENT_ID } from "../../shared/agents";
import { IPC } from "../../shared/ipc-channels";
import { findAgent, listAgents } from "../agents/agents";
import { resolvePrompt } from "../agents/prompts";
import { HistoryStore } from "../db/history";
import type { ModelManager } from "../models/model-manager";
import type { RagEngine } from "../rag/rag-engine";

const MAX_ID_CHARS = 64;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;
const MAX_URL_CHARS = 2048;
const MAX_COPY_CHARS = 1_000_000;

interface InFlight {
  controller: AbortController;
  conversationId: string;
  done: Promise<unknown>;
}

let history: HistoryStore | null = null;
const inFlight = new Map<string, InFlight>();

export interface ChatRagOptions {
  engine: RagEngine;
  /** Há base de conhecimento com trechos (habilita o agente `wikipedia`). */
  knowledgeInstalled(): boolean;
}

function store(): HistoryStore {
  if (!history) throw new Error("Histórico indisponível.");
  return history;
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function changed(conversationId: string | null): void {
  broadcast(IPC.chatChanged, { conversationId });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- validação de entrada do Renderer ---------------------------------------

function field<T = unknown>(payload: unknown, name: string): T {
  return (payload as Record<string, T> | null)?.[name] as T;
}

function assertId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) throw new Error(`${name} inválido.`);
  return value;
}

function assertConversation(payload: unknown): Conversation {
  const conversation = store().getConversation(assertId(field(payload, "conversationId"), "conversationId"));
  if (!conversation) throw new Error("Conversa não encontrada.");
  return conversation;
}

function assertTitle(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title || title.length > MAX_TITLE_CHARS) throw new Error("Título inválido.");
  return title;
}

// ---- geração ------------------------------------------------------------------

/** Mensagens válidas da conversa para o modelo (sem sistema, erros nem parciais vazios). */
function conversationMessages(conversation: Conversation): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const m of store().messages(conversation.id)) {
    if (m.role === "system" || m.status === "error") continue;
    if (m.status === "canceled" && !m.content.trim()) continue;
    messages.push({ role: m.role, content: m.content });
  }
  return messages;
}

interface ReplyResult {
  text: string;
  canceled: boolean;
  promptVersion: string;
  usedRag: boolean;
  sources: Message["sources"];
}

/**
 * Gera a resposta para a última pergunta. O agente decide: com `useKnowledge`, passa pelo RAG
 * (retrieval refeito a cada envio/regeneração); sem, vai direto ao LLM com o prompt do agente.
 */
async function generateReply(
  manager: ModelManager,
  rag: ChatRagOptions,
  conversation: Conversation,
  signal: AbortSignal,
  onToken: (chunk: string) => void,
): Promise<ReplyResult> {
  const knowledge = rag.knowledgeInstalled();
  const agent = findAgent(conversation.agentId, knowledge) ?? findAgent(DEFAULT_AGENT_ID, knowledge)!;
  if (!agent.available) throw new Error(`O agente "${agent.name}" está indisponível: ${agent.reason}.`);
  const messages = conversationMessages(conversation);

  if (agent.useKnowledge) {
    const question = messages.at(-1);
    if (!question || question.role !== "user") throw new Error("A última mensagem precisa ser do usuário.");
    const answer = await rag.engine.answer({ messages: messages.slice(0, -1), question: question.content, signal, onToken });
    return { text: answer.text, canceled: answer.canceled, promptVersion: answer.promptVersion, usedRag: true, sources: answer.sources };
  }

  const prompt = resolvePrompt(agent.systemPromptId);
  const result = await manager.generate({
    messages: [{ role: "system", content: prompt.build({ now: new Date() }) }, ...messages],
    signal,
    onTextChunk: onToken,
  });
  return { text: result.text, canceled: result.canceled, promptVersion: agent.systemPromptId, usedRag: false, sources: null };
}

/** Gera a resposta para a última pergunta da conversa, com streaming para `sender`, e persiste. */
/** Antes de gravar ou apagar qualquer coisa: uma geração por conversa, requestId único. */
function assertIdle(conversationId: string, requestId: string): void {
  if (inFlight.has(requestId)) throw new Error("requestId já está em uso.");
  for (const job of inFlight.values()) {
    if (job.conversationId === conversationId) throw new Error("Já há uma resposta sendo gerada nesta conversa.");
  }
}

/** Grava a resposta só se a conversa ainda existir (pode ter sido excluída durante a geração). */
function persistReply(input: Parameters<HistoryStore["addMessage"]>[0]): Message | null {
  if (!history?.getConversation(input.conversationId)) return null;
  return history.addMessage(input);
}

function reply(
  manager: ModelManager,
  rag: ChatRagOptions,
  sender: WebContents,
  conversation: Conversation,
  requestId: string,
): Promise<Message | null> {
  assertIdle(conversation.id, requestId);
  const send = (channel: string, payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  const controller = new AbortController();
  const run = async (): Promise<Message | null> => {
    const modelId = manager.active().id;
    let streamed = "";
    try {
      const result = await generateReply(manager, rag, conversation, controller.signal, (chunk) => {
        streamed += chunk;
        send(IPC.llmToken, { requestId, chunk });
      });
      const text = result.text || streamed;
      // Cancelado sem nenhum texto: não há o que guardar.
      const saved =
        result.canceled && !text.trim()
          ? null
          : persistReply({
              conversationId: conversation.id,
              role: "assistant",
              content: text,
              modelId,
              status: result.canceled ? "canceled" : "complete",
              promptVersion: result.promptVersion,
              usedRag: result.usedRag,
              sources: result.sources,
            });
      if (result.canceled) console.info(`[chat] geração ${requestId} interrompida (${text.length} caracteres guardados)`);
      send(IPC.llmDone, { requestId, fullText: text, canceled: result.canceled });
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      persistReply({ conversationId: conversation.id, role: "assistant", content: message, modelId, status: "error" });
      send(IPC.llmError, { requestId, message });
      throw error;
    } finally {
      inFlight.delete(requestId);
      changed(conversation.id);
    }
  };
  const done = run();
  inFlight.set(requestId, { controller, conversationId: conversation.id, done: done.catch(() => undefined) });
  return done;
}

// ---- handlers -----------------------------------------------------------------

export function registerChatHandlers(manager: ModelManager, rag: ChatRagOptions): void {
  history = new HistoryStore(path.join(app.getPath("userData"), "history.sqlite"));
  const config = manager.config;
  const agent = (id: string) => findAgent(id, rag.knowledgeInstalled());

  ipcMain.handle(IPC.chatList, () => store().listConversations());

  ipcMain.handle(IPC.chatCreate, (_event, payload: unknown) => {
    const rawTitle = field(payload, "title");
    const title = rawTitle === undefined ? DEFAULT_CONVERSATION_TITLE : assertTitle(rawTitle);
    const agentId = agent(config.get().lastAgentId)?.available ? config.get().lastAgentId : DEFAULT_AGENT_ID;
    const conversation = store().createConversation({ title, agentId, modelId: manager.active().id });
    changed(conversation.id);
    return conversation;
  });

  ipcMain.handle(IPC.chatMessages, (_event, payload: unknown) => store().messages(assertConversation(payload).id));

  ipcMain.handle(IPC.chatRename, (_event, payload: unknown) => {
    const conversation = assertConversation(payload);
    store().renameConversation(conversation.id, assertTitle(field(payload, "title")));
    changed(conversation.id);
  });

  ipcMain.handle(IPC.chatDelete, async (_event, payload: unknown) => {
    const conversation = assertConversation(payload);
    // Interrompe a geração desta conversa e espera ela terminar antes de apagar.
    const jobs = [...inFlight.values()].filter((job) => job.conversationId === conversation.id);
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.done));
    store().deleteConversation(conversation.id);
    changed(conversation.id);
  });

  ipcMain.handle(IPC.chatClear, (_event, payload: unknown) => {
    const conversation = assertConversation(payload);
    for (const job of inFlight.values()) {
      if (job.conversationId === conversation.id) throw new Error("Cancele a resposta em andamento antes de limpar.");
    }
    store().clearMessages(conversation.id);
    changed(conversation.id);
  });

  ipcMain.handle(IPC.chatSend, async (event, payload: unknown) => {
    const conversation = assertConversation(payload);
    const requestId = assertId(field(payload, "requestId"), "requestId");
    const content = field(payload, "content");
    if (typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_CHARS) {
      throw new Error("Mensagem vazia ou longa demais.");
    }
    assertIdle(conversation.id, requestId);
    const first = store().countMessages(conversation.id) === 0;
    store().addMessage({ conversationId: conversation.id, role: "user", content });
    if (first && conversation.title === DEFAULT_CONVERSATION_TITLE) {
      store().renameConversation(conversation.id, titleFromQuestion(content));
    }
    changed(conversation.id);
    return reply(manager, rag, event.sender, store().getConversation(conversation.id)!, requestId);
  });

  ipcMain.handle(IPC.chatRegenerate, async (event, payload: unknown) => {
    const conversation = assertConversation(payload);
    const requestId = assertId(field(payload, "requestId"), "requestId");
    assertIdle(conversation.id, requestId);
    const messages = store().messages(conversation.id);
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) throw new Error("Não há pergunta para regenerar.");
    // Apaga a(s) resposta(s) depois da última pergunta (inclusive erro/cancelada) e gera de novo.
    store().deleteMessages(messages.slice(lastUser + 1).map((m) => m.id));
    return reply(manager, rag, event.sender, conversation, requestId);
  });

  ipcMain.handle(IPC.chatCancel, (_event, payload: unknown) => {
    const requestId = assertId(field(payload, "requestId"), "requestId");
    const job = inFlight.get(requestId);
    if (job) {
      console.info(`[chat] cancelar ${requestId}`);
      job.controller.abort();
    }
  });

  ipcMain.handle(IPC.agentsList, () => listAgents(rag.knowledgeInstalled()));
  ipcMain.handle(IPC.agentsLastUsed, () =>
    agent(config.get().lastAgentId)?.available ? config.get().lastAgentId : DEFAULT_AGENT_ID,
  );

  ipcMain.handle(IPC.chatSetAgent, (_event, payload: unknown) => {
    const chosen = agent(assertId(field(payload, "agentId"), "agentId"));
    if (!chosen) throw new Error("Agente desconhecido.");
    if (!chosen.available) throw new Error(`O agente "${chosen.name}" está indisponível: ${chosen.reason}.`);
    const conversationId = field(payload, "conversationId");
    if (conversationId !== null && conversationId !== undefined) {
      const conversation = assertConversation(payload);
      store().setAgent(conversation.id, chosen.id);
      changed(conversation.id);
    }
    return config.update((c) => {
      c.lastAgentId = chosen.id;
    });
  });

  ipcMain.handle(IPC.appOpenExternal, async (_event, payload: unknown) => {
    const raw = field(payload, "url");
    if (typeof raw !== "string" || raw.length > MAX_URL_CHARS) throw new Error("URL inválida.");
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Só links http/https podem ser abertos.");
    await shell.openExternal(url.toString());
  });

  ipcMain.handle(IPC.appCopyText, (_event, payload: unknown) => {
    const text = field(payload, "text");
    if (typeof text !== "string" || text.length > MAX_COPY_CHARS) throw new Error("Texto inválido.");
    clipboard.writeText(text);
  });
}

/** Encerramento: aborta gerações (o parcial é gravado como `canceled`), espera terminarem e fecha o banco. */
export async function shutdownChat(): Promise<void> {
  for (const job of inFlight.values()) job.controller.abort();
  await Promise.all([...inFlight.values()].map((job) => job.done));
  history?.close();
  history = null;
}
