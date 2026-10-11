import { useCallback, useEffect, useState } from "react";
import { ConversationList } from "./components/ConversationList";
import { useActiveModel } from "./lib/useActiveModel";
import { useAgents } from "./lib/useAgents";
import { useConversations } from "./lib/useConversations";
import { useModels } from "./lib/useModels";
import { useChatScreen } from "./screens/Chat";
import { SettingsScreen, type SettingsSection } from "./screens/settings/SettingsScreen";
import { Button } from "./ui/Button";
import { Shell } from "./ui/Shell";

type View = "chat" | `settings:${SettingsSection}`;

function App() {
  const [view, setView] = useState<View>("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const models = useModels();
  const active = useActiveModel();
  const agents = useAgents();
  const { conversations, error: conversationsError } = useConversations();

  const openConversation = useCallback((id: string | null) => {
    setConversationId(id);
    setView("chat");
  }, []);

  const chat = useChatScreen({
    conversationId,
    conversations,
    onConversationChange: openConversation,
    models,
    active,
    agents,
    onOpenModels: () => setView("settings:models"),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "b") {
        event.preventDefault();
        setCollapsed((value) => !value);
      } else if (event.key === ",") {
        event.preventDefault();
        setView("settings:models");
      } else if (event.key === "n") {
        event.preventDefault();
        openConversation(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openConversation]);

  const inSettings = view !== "chat";
  const header = inSettings ? (
    <>
      <Button variant="ghost" onClick={() => setView("chat")}>
        ← Voltar
      </Button>
      <span>Configurações</span>
      <span className="spacer" />
    </>
  ) : (
    chat.header
  );

  return (
    <Shell
      collapsed={collapsed}
      view={inSettings ? "settings" : "chat"}
      onNewChat={() => openConversation(null)}
      onOpenSettings={() => setView("settings:models")}
      header={header}
      sidebar={
        <ConversationList
          conversations={conversations}
          error={conversationsError}
          activeId={inSettings ? null : conversationId}
          onSelect={openConversation}
          onDeleted={(id) => setConversationId((current) => (current === id ? null : current))}
        />
      }
      footer={inSettings ? undefined : chat.footer}
    >
      {inSettings ? (
        <SettingsScreen
          section={view.slice("settings:".length) as SettingsSection}
          onSelect={(section) => setView(`settings:${section}`)}
          models={models}
          agents={agents}
        />
      ) : (
        chat.body
      )}
    </Shell>
  );
}

export default App;
