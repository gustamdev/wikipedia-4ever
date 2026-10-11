// Histórico de conversas em SQLite (better-sqlite3, síncrono). Sem dependência do Electron.
// Toda query usa prepared statements com parâmetros; nada de concatenar SQL.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Conversation, Message, MessageRole, MessageStatus } from "../../shared/chat";
import type { RagSource } from "../../shared/rag";

/**
 * Migrations em ordem; `PRAGMA user_version` guarda quantas já rodaram.
 * Nunca editar uma migration publicada: acrescentar uma nova (a Semana 9 adiciona as fontes).
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — schema inicial (Semana 4). `prompt_version` antecipado da Semana 9.
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model_id TEXT,
    agent_id TEXT NOT NULL DEFAULT 'assistant',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    model_id TEXT,
    status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','canceled','error')),
    prompt_version TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
  CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
  `,
  // 2 — RAG (Semana 9): fontes usadas em cada resposta.
  `
  ALTER TABLE messages ADD COLUMN sources_json TEXT;
  ALTER TABLE messages ADD COLUMN used_rag INTEGER NOT NULL DEFAULT 0;
  `,
];

interface ConversationRow {
  id: string;
  title: string;
  model_id: string | null;
  agent_id: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model_id: string | null;
  status: MessageStatus;
  prompt_version: string | null;
  sources_json: string | null;
  used_rag: number;
  created_at: number;
}

function isSource(value: unknown): value is RagSource {
  const v = value as RagSource;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.chunk_id === "string" &&
    typeof v.document_title === "string" &&
    (v.section === null || typeof v.section === "string") &&
    typeof v.url === "string" &&
    typeof v.text === "string" &&
    typeof v.score === "number"
  );
}

/** JSON ilegível ou fora do formato → sem fontes (nunca derruba a leitura da conversa). */
function parseSources(json: string | null): RagSource[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isSource) : null;
  } catch {
    return null;
  }
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  modelId: r.model_id,
  agentId: r.agent_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  modelId: r.model_id,
  status: r.status,
  promptVersion: r.prompt_version,
  usedRag: r.used_rag === 1,
  sources: parseSources(r.sources_json),
  createdAt: r.created_at,
});

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  modelId?: string | null;
  status?: MessageStatus;
  promptVersion?: string | null;
  usedRag?: boolean;
  sources?: RagSource[] | null;
}

function prepareStatements(db: Database.Database) {
  return {
    insertConversation: db.prepare<[string, string, string | null, string, number, number]>(
      "INSERT INTO conversations (id, title, model_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    listConversations: db.prepare<[], ConversationRow>("SELECT * FROM conversations ORDER BY updated_at DESC"),
    getConversation: db.prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE id = ?"),
    rename: db.prepare<[string, number, string]>("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?"),
    setAgent: db.prepare<[string, string]>("UPDATE conversations SET agent_id = ? WHERE id = ?"),
    touch: db.prepare<[number, string | null, string]>(
      "UPDATE conversations SET updated_at = ?, model_id = COALESCE(?, model_id) WHERE id = ?",
    ),
    deleteConversation: db.prepare<[string]>("DELETE FROM conversations WHERE id = ?"),
    insertMessage: db.prepare<
      [string, string, MessageRole, string, string | null, MessageStatus, string | null, string | null, number, number]
    >(
      "INSERT INTO messages (id, conversation_id, role, content, model_id, status, prompt_version, sources_json, used_rag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    messages: db.prepare<[string], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    ),
    countMessages: db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?"),
    deleteMessage: db.prepare<[string]>("DELETE FROM messages WHERE id = ?"),
    clearMessages: db.prepare<[string]>("DELETE FROM messages WHERE conversation_id = ?"),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

export class HistoryStore {
  private readonly db: Database.Database;
  private readonly stmt: Statements;
  /** Garante `created_at` estritamente crescente na mesma conversa (ordem estável mesmo no mesmo ms). */
  private lastTimestamp = 0;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.stmt = prepareStatements(this.db);
  }

  get schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `history.sqlite está na versão ${current}, mais nova que este app (${MIGRATIONS.length}). Atualize o app.`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      // Cada migration + o novo user_version numa transação: ou tudo, ou nada.
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.pragma(`user_version = ${version + 1}`);
      })();
    }
  }

  private now(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  createConversation(input: { title: string; agentId: string; modelId?: string | null }): Conversation {
    const id = randomUUID();
    const now = this.now();
    this.stmt.insertConversation.run(id, input.title, input.modelId ?? null, input.agentId, now, now);
    return this.getConversation(id)!;
  }

  listConversations(): Conversation[] {
    return this.stmt.listConversations.all().map(toConversation);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.stmt.getConversation.get(id);
    return row && toConversation(row);
  }

  renameConversation(id: string, title: string): void {
    this.stmt.rename.run(title, this.now(), id);
  }

  setAgent(id: string, agentId: string): void {
    this.stmt.setAgent.run(agentId, id);
  }

  /** Apaga a conversa; as mensagens vão junto (`ON DELETE CASCADE`). */
  deleteConversation(id: string): void {
    this.stmt.deleteConversation.run(id);
  }

  addMessage(input: NewMessage): Message {
    const id = randomUUID();
    const now = this.now();
    const insert = this.db.transaction(() => {
      this.stmt.insertMessage.run(
        id,
        input.conversationId,
        input.role,
        input.content,
        input.modelId ?? null,
        input.status ?? "complete",
        input.promptVersion ?? null,
        input.sources ? JSON.stringify(input.sources) : null,
        input.usedRag ? 1 : 0,
        now,
      );
      this.stmt.touch.run(now, input.modelId ?? null, input.conversationId);
    });
    insert();
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      modelId: input.modelId ?? null,
      status: input.status ?? "complete",
      promptVersion: input.promptVersion ?? null,
      usedRag: input.usedRag ?? false,
      sources: input.sources ?? null,
      createdAt: now,
    };
  }

  messages(conversationId: string): Message[] {
    return this.stmt.messages.all(conversationId).map(toMessage);
  }

  countMessages(conversationId: string): number {
    return this.stmt.countMessages.get(conversationId)?.n ?? 0;
  }

  deleteMessages(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.stmt.deleteMessage.run(id);
    })();
  }

  clearMessages(conversationId: string): void {
    this.stmt.clearMessages.run(conversationId);
    this.stmt.touch.run(this.now(), null, conversationId);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
