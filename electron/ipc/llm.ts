import { ipcMain } from "electron";
import type { ChatMessage, ChatRole } from "../../shared/electron-api";
import { IPC } from "../../shared/ipc-channels";
import type { ModelManager } from "../models/model-manager";

const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_MESSAGES = 500;
const MAX_REQUEST_ID_CHARS = 64;
const ROLES = new Set<ChatRole>(["system", "user", "assistant"]);

const inFlight = new Map<string, AbortController>();

function assertRequestId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_CHARS) {
    throw new Error("requestId inválido.");
  }
  return value;
}

/** Aceita um prompt simples (compatível com a Semana 1) ou `{ messages }` com o histórico completo. */
function parseInput(input: unknown): ChatMessage[] {
  if (typeof input === "string") {
    if (input.trim().length === 0 || input.length > MAX_MESSAGE_CHARS) throw new Error("prompt inválido.");
    return [{ role: "user", content: input }];
  }
  const messages = (input as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new Error("messages inválido.");
  }
  let total = 0;
  const parsed = messages.map((raw): ChatMessage => {
    const m = raw as Partial<ChatMessage> | null;
    if (!m || !ROLES.has(m.role as ChatRole) || typeof m.content !== "string" || m.content.length > MAX_MESSAGE_CHARS) {
      throw new Error("mensagem inválida.");
    }
    total += m.content.length;
    return { role: m.role as ChatRole, content: m.content };
  });
  if (total > MAX_TOTAL_CHARS) throw new Error("histórico grande demais.");
  const last = parsed[parsed.length - 1];
  if (last.role !== "user" || last.content.trim().length === 0) throw new Error("a última mensagem precisa ser do usuário.");
  return parsed;
}

export function registerLlmHandlers(manager: ModelManager): void {
  ipcMain.handle(IPC.llmGenerate, async (event, rawRequestId: unknown, input: unknown) => {
    const requestId = assertRequestId(rawRequestId);
    const messages = parseInput(input);
    if (inFlight.has(requestId)) throw new Error("requestId já está em uso.");

    const sender = event.sender;
    const send = (channel: string, payload: unknown) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };

    const controller = new AbortController();
    inFlight.set(requestId, controller);
    try {
      const { text, canceled } = await manager.generate({
        messages,
        signal: controller.signal,
        onTextChunk: (chunk) => send(IPC.llmToken, { requestId, chunk }),
      });
      send(IPC.llmDone, { requestId, fullText: text, canceled });
      return { requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(IPC.llmError, { requestId, message });
      throw error;
    } finally {
      inFlight.delete(requestId);
    }
  });

  ipcMain.handle(IPC.llmCancel, (_event, rawRequestId: unknown) => {
    inFlight.get(assertRequestId(rawRequestId))?.abort();
  });
}

export function cancelAllGenerations(): void {
  for (const controller of inFlight.values()) controller.abort();
}
