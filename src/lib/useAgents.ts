import { useEffect, useState } from "react";
import type { AgentInfo } from "../../shared/agents";

/** Agentes e disponibilidade; recarrega quando uma indexação muda de estado (o agente Wikipedia depende da base). */
export function useAgents(): AgentInfo[] | null {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  useEffect(() => {
    const load = () => {
      window.electronAPI.agents.list().then(setAgents).catch(() => setAgents([]));
    };
    load();
    return window.electronAPI.ingestion.onStatusChanged(load);
  }, []);
  return agents;
}
