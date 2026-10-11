import { useCallback, useEffect, useState } from "react";
import type { AgentInfo } from "../../shared/agents";
import type { Conversation } from "../../shared/chat";
import type { ActiveModel } from "../../shared/models";
import { AgentSelector } from "../components/AgentSelector";
import { ChatInput } from "../components/ChatInput";
import { MessageList } from "../components/MessageList";
import { ModelSelector } from "../components/ModelSelector";
import { useConversation } from "../lib/useConversation";
import type { ModelsState } from "../lib/useModels";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { EmptyState, ErrorState } from "../ui/States";

interface ChatProps {
  conversationId: string | null;
  conversations: Conversation[] | null;
  onConversationChange: (id: string | null) => void;
  models: ModelsState;
  active: ActiveModel | null;
  agents: AgentInfo[] | null;
  onOpenModels: () => void;
}

function focusPicker(id: string) {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  select?.focus();
  try {
    select?.showPicker();
  } catch {
    // showPicker exige gesto do usuário em alguns casos; o foco já basta.
  }
}

/** Tela de chat: devolve header, corpo e input para o Shell. */
export function useChatScreen({ conversationId, conversations, onConversationChange, models, active, agents, onOpenModels }: ChatProps) {
  const [draftAgent, setDraftAgent] = useState("assistant");
  useEffect(() => {
    window.electronAPI.agents.lastUsed().then(setDraftAgent).catch(() => undefined);
  }, []);

  const ensureConversation = useCallback(async () => {
    const conversation = await window.electronAPI.chat.create();
    onConversationChange(conversation.id);
    return conversation.id;
  }, [onConversationChange]);

  const chat = useConversation(conversationId, ensureConversation);
  const conversation = conversations?.find((c) => c.id === conversationId) ?? null;
  const agentId = conversation?.agentId ?? draftAgent;
  const busy = chat.pending !== null;

  // Esc cancela a geração (com o foco no input ou fora dele).
  const { cancel } = chat;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy && !event.defaultPrevented) cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, cancel]);

  const [agentError, setAgentError] = useState<string | null>(null);
  const changeAgent = (id: string) => {
    setDraftAgent(id);
    setAgentError(null);
    window.electronAPI.chat
      .setAgent(conversationId, id)
      .catch((e: unknown) => setAgentError(e instanceof Error ? e.message : String(e)));
  };

  const runCommand = (name: string) => {
    if (name === "/new") onConversationChange(null);
    else if (name === "/agent") focusPicker("agent-picker");
    else if (name === "/model") focusPicker("model-picker");
    else if (name === "/clear" && conversationId) void window.electronAPI.chat.clear(conversationId);
  };

  const header = (
    <>
      <AgentSelector agents={agents} value={agentId} error={agentError} onChange={changeAgent} />
      <ModelSelector models={models.models} active={active} />
      <span className="spacer" />
    </>
  );

  const installed = models.models?.filter((m) => m.status.state === "installed") ?? [];
  const hasModel = installed.length > 0 || active?.state === "ready";
  let body;
  if (models.error) {
    body = (
      <ErrorState
        title="Não foi possível carregar os modelos"
        hint={models.error}
        action={<Button onClick={models.reload}>Tentar novamente</Button>}
      />
    );
  } else if (!models.models) {
    body = (
      <div className="state">
        <span>
          <Spinner /> carregando…
        </span>
      </div>
    );
  } else if (!hasModel) {
    body = (
      <EmptyState
        title="Nenhum modelo instalado"
        hint="Para conversar, instale um modelo de linguagem. Ele roda no seu computador e funciona sem internet."
        action={
          <Button variant="primary" onClick={onOpenModels}>
            Instalar um modelo
          </Button>
        }
      />
    );
  } else if (chat.messages.length === 0 && !chat.pending && !chat.error) {
    body = chat.loading ? (
      <div className="state">
        <span>
          <Spinner /> abrindo conversa…
        </span>
      </div>
    ) : (
      <EmptyState
        title={conversation ? conversation.title : "Nova conversa"}
        hint={
          active?.state === "ready" || active?.state === "loading"
            ? "Faça uma pergunta. Digite / para ver os comandos."
            : "Escolha um modelo no topo da tela para começar."
        }
      />
    );
  } else {
    const pending = chat.pending && chat.pending.conversationId === conversationId ? chat.pending : null;
    body = (
      <MessageList
        messages={chat.messages}
        pending={pending}
        error={chat.error}
        onRegenerate={chat.regenerate}
        onCancel={chat.cancel}
      />
    );
  }

  const ready = active?.state === "ready" || active?.state === "loading";
  const footer = hasModel ? (
    <ChatInput
      busy={busy}
      disabled={!ready}
      placeholder={ready ? "escreva aqui…" : "escolha um modelo no topo para conversar"}
      onSend={chat.send}
      onCommand={runCommand}
    />
  ) : undefined;

  return { header, body, footer, busy };
}
