import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../../shared/chat";
import type { Pending } from "../lib/useConversation";
import { MarkdownMessage } from "./MarkdownMessage";
import { SourceList } from "./SourceList";

/** Distância do fim (px) abaixo da qual a lista acompanha o streaming. */
const STICK_THRESHOLD = 48;

interface MessageListProps {
  messages: Message[];
  pending: Pending | null;
  error: string | null;
  onRegenerate: () => void;
  onCancel: () => void;
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-action"
      onClick={() => {
        void window.electronAPI.app.copyText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "copiado" : "copiar"}
    </button>
  );
}

function UserLine({ content }: { content: string }) {
  return (
    <div className="msg msg--user">
      <span className="msg__prefix" aria-hidden="true">
        &gt;
      </span>
      <span className="msg__text msg__text--plain">{content}</span>
    </div>
  );
}

export function MessageList({ messages, pending, error, onRegenerate, onCancel }: MessageListProps) {
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Acompanha se o usuário está perto do fim; se subiu para ler, o streaming não puxa a rolagem.
  useEffect(() => {
    const scroller = end.current?.closest(".main__body");
    if (!scroller) return;
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages, pending?.text, pending?.requestId, error]);

  const last = messages[messages.length - 1];
  // Regenerar: na última resposta; "gerar resposta" quando a conversa termina numa pergunta sem resposta.
  const regenerateLast = !pending && last?.role === "assistant";
  const answerMissing = !pending && last?.role === "user";

  return (
    <div className="transcript" aria-live="polite">
      {messages.map((m, index) =>
        m.role === "user" ? (
          <UserLine key={m.id} content={m.content} />
        ) : m.role === "assistant" ? (
          <div key={m.id} className={`msg msg--assistant msg--${m.status}`}>
            <span className="msg__prefix" aria-hidden="true">
              {m.status === "error" ? "✕" : "●"}
            </span>
            <div className="msg__body">
              {m.status === "error" ? (
                <span className="msg__text msg__text--plain msg__text--error">{m.content}</span>
              ) : (
                <MarkdownMessage text={m.content} />
              )}
              {m.usedRag && m.status !== "error" && <SourceList sources={m.sources ?? []} />}
              <div className="msg__actions">
                {m.status === "canceled" && <span className="msg__meta">interrompida</span>}
                {m.status !== "error" && <CopyAction text={m.content} />}
                {index === messages.length - 1 && regenerateLast && (
                  <button type="button" className="link-action" onClick={onRegenerate}>
                    regenerar
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null,
      )}

      {/* Pergunta recém-enviada sem resposta (ex.: erro antes de gerar): permite regenerar. */}
      {answerMissing && (
        <div className="msg__status">
          sem resposta ·{" "}
          <button type="button" className="link-action" onClick={onRegenerate}>
            gerar resposta
          </button>
        </div>
      )}

      {pending && (
        <>
          {pending.kind === "send" && pending.question && <UserLine content={pending.question} />}
          <div className="msg msg--assistant">
            <span className="msg__prefix" aria-hidden="true">
              ●
            </span>
            <div className="msg__body">
              {pending.text ? (
                <MarkdownMessage text={pending.text} />
              ) : (
                <span className="msg__meta">gerando…</span>
              )}
              <span className="cursor" aria-hidden="true">
                ▍
              </span>
              <div className="msg__actions">
                <button type="button" className="link-action" onClick={onCancel}>
                  [esc] cancelar
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="msg__status msg__status--error" role="alert">
          ✕ {error}
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
