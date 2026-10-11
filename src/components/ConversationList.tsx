import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/chat";

const DAY = 24 * 60 * 60 * 1000;

function groupOf(updatedAt: number, now: Date): "Hoje" | "Ontem" | "Anteriores" {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (updatedAt >= startOfToday) return "Hoje";
  if (updatedAt >= startOfToday - DAY) return "Ontem";
  return "Anteriores";
}

interface ItemProps {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}

function ConversationItem({ conversation, active, onSelect, onDeleted }: ItemProps) {
  const [mode, setMode] = useState<"idle" | "menu" | "rename" | "confirm">("idle");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") input.current?.select();
  }, [mode]);

  const rename = (title: string) => {
    if (!title.trim() || title.trim() === conversation.title) return setMode("idle");
    window.electronAPI.chat
      .rename(conversation.id, title)
      .then(() => setMode("idle"))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (mode === "rename") {
    return (
      <div className="conv conv--editing">
        <input
          ref={input}
          className="conv__input"
          aria-label="Novo título"
          defaultValue={conversation.title}
          maxLength={200}
          onKeyDown={(event) => {
            if (event.key === "Enter") rename(event.currentTarget.value);
            if (event.key === "Escape") setMode("idle");
          }}
          onBlur={(event) => rename(event.currentTarget.value)}
        />
        {error && <div className="conv__error">{error}</div>}
      </div>
    );
  }

  return (
    <div
      className="conv"
      data-active={active}
      onContextMenu={(event) => {
        event.preventDefault();
        setMode("menu");
      }}
      onMouseLeave={() => mode === "menu" && setMode("idle")}
    >
      <button type="button" className="conv__title" aria-current={active} onClick={onSelect} title={conversation.title}>
        {conversation.title}
      </button>
      {error && <div className="conv__error">{error}</div>}
      {mode === "confirm" ? (
        <span className="conv__confirm">
          excluir?{" "}
          <button type="button" className="link-action link-action--danger" onClick={() => {
              window.electronAPI.chat
                .delete(conversation.id)
                .then(onDeleted)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}>
            sim
          </button>{" "}
          <button type="button" className="link-action" onClick={() => setMode("idle")} autoFocus>
            não
          </button>
        </span>
      ) : (
        <span className="conv__actions" data-open={mode === "menu"}>
          <button type="button" className="link-action" aria-label={`Renomear ${conversation.title}`} onClick={() => setMode("rename")}>
            renomear
          </button>
          <button type="button" className="link-action" aria-label={`Excluir ${conversation.title}`} onClick={() => setMode("confirm")}>
            excluir
          </button>
        </span>
      )}
    </div>
  );
}

interface ConversationListProps {
  conversations: Conversation[] | null;
  error: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

/** Conversas agrupadas por data (Hoje / Ontem / Anteriores), renomear e excluir por hover ou menu de contexto. */
export function ConversationList({ conversations, error, activeId, onSelect, onDeleted }: ConversationListProps) {
  if (error) return <div className="sidebar__group conv__error">✕ {error}</div>;
  if (!conversations) return <div className="sidebar__group">carregando…</div>;
  if (conversations.length === 0) return <div className="sidebar__group">(nenhuma conversa ainda)</div>;

  const now = new Date();
  const groups = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const key = groupOf(c.updatedAt, now);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <>
      {[...groups].map(([label, items]) => (
        <section key={label} aria-label={label}>
          <div className="sidebar__group">{label}</div>
          {items.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              onSelect={() => onSelect(c.id)}
              onDeleted={() => onDeleted(c.id)}
            />
          ))}
        </section>
      ))}
    </>
  );
}
