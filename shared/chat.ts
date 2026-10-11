// Conversas e mensagens (persistidas no SQLite do Main; o Renderer não é a fonte da verdade).
import type { RagSource } from "./rag";

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "complete" | "canceled" | "error";

export interface Conversation {
  id: string;
  title: string;
  /** Último modelo usado. */
  modelId: string | null;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  /** Para `status: "error"`, a mensagem de erro exibida ao usuário. */
  content: string;
  modelId: string | null;
  status: MessageStatus;
  /** Ex.: "assistant-system@1" ou "rag-system@1+rag-context@1" (respostas do assistente). */
  promptVersion: string | null;
  /** Resposta passou pelo RAG (agente com base de conhecimento). */
  usedRag: boolean;
  /** Trechos que entraram no prompt, na ordem das citações `[n]`; null sem RAG. */
  sources: RagSource[] | null;
  createdAt: number;
}

export const DEFAULT_CONVERSATION_TITLE = "Nova conversa";
export const TITLE_MAX_CHARS = 40;

/** Título default: primeiros ~40 caracteres da 1ª pergunta, numa linha. */
export function titleFromQuestion(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_CHARS) return oneLine || DEFAULT_CONVERSATION_TITLE;
  return `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}
