import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../shared/chat";

export interface Pending {
  requestId: string;
  conversationId: string;
  kind: "send" | "regenerate";
  /** Pergunta enviada (exibida antes de o Main confirmar a gravação). */
  question?: string;
  /** Texto recebido até agora por streaming. */
  text: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
}

/**
 * Mensagens da conversa aberta + geração em andamento. O banco (Main) é a fonte da verdade:
 * ao terminar uma geração, as mensagens são recarregadas de lá.
 */
export function useConversation(conversationId: string | null, ensureConversation: () => Promise<string>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const currentId = useRef(conversationId);
  currentId.current = conversationId;

  const reload = useCallback((id: string | null) => {
    if (!id) {
      setMessages([]);
      return Promise.resolve();
    }
    setLoading(true);
    return window.electronAPI.chat
      .messages(id)
      .then((list) => {
        if (currentId.current === id) setMessages(list);
      })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setError(null);
    void reload(conversationId);
  }, [conversationId, reload]);

  // Streaming: tokens do requestId em andamento.
  useEffect(() => {
    return window.electronAPI.llm.onToken(({ requestId, chunk }) => {
      const p = pendingRef.current;
      if (!p || p.requestId !== requestId) return;
      pendingRef.current = { ...p, text: p.text + chunk };
      setPending(pendingRef.current);
    });
  }, []);

  // Outra parte do app (ou outra conversa) mudou o banco: recarrega se for esta e não estiver gerando.
  useEffect(() => {
    return window.electronAPI.chat.onChanged(({ conversationId: changed }) => {
      if (changed && changed === currentId.current && !pendingRef.current) void reload(changed);
    });
  }, [reload]);

  const run = useCallback(
    async (kind: Pending["kind"], question?: string) => {
      if (pendingRef.current) return false;
      setError(null);
      const requestId = crypto.randomUUID();
      // Marca como ocupado ANTES de criar a conversa: Enter duplo não cria duas.
      pendingRef.current = { requestId, conversationId: conversationId ?? "", kind, question, text: "" };
      setPending(pendingRef.current);
      if (kind === "regenerate") {
        // Esconde a resposta que será substituída enquanto a nova chega.
        setMessages((list) => list.slice(0, list.map((m) => m.role).lastIndexOf("user") + 1));
      }
      try {
        const id = conversationId ?? (await ensureConversation());
        pendingRef.current = { ...pendingRef.current, conversationId: id };
        setPending(pendingRef.current);
        if (kind === "send") await window.electronAPI.chat.send(id, requestId, question!);
        else await window.electronAPI.chat.regenerate(id, requestId);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        pendingRef.current = null;
        setPending(null);
        await reload(currentId.current);
      }
      return true;
    },
    [conversationId, ensureConversation, reload],
  );

  const send = useCallback((text: string) => {
    const question = text.trim();
    if (!question || pendingRef.current) return false;
    void run("send", question);
    return true;
  }, [run]);

  const regenerate = useCallback(() => void run("regenerate"), [run]);

  const cancel = useCallback(() => {
    const p = pendingRef.current;
    if (p) void window.electronAPI.chat.cancel(p.requestId);
  }, []);

  return { messages, loading, error, pending, send, regenerate, cancel, reload: () => reload(conversationId) };
}
