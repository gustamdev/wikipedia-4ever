import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "../../shared/chat";

/** Lista de conversas (mais recente primeiro), recarregada a cada `chat:changed`. */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    window.electronAPI.chat
      .list()
      .then((list) => {
        setConversations(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reload();
    return window.electronAPI.chat.onChanged(reload);
  }, [reload]);

  return { conversations, error, reload };
}
