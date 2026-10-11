import type { AgentDefinition, AgentInfo } from "../../shared/agents";

const AGENTS: readonly AgentDefinition[] = [
  {
    id: "assistant",
    name: "Assistente",
    description: "Conversa livre com o modelo local. Responde só com o que o modelo aprendeu no treinamento, sem consultar a Wikipedia.",
    systemPromptId: "assistant-system@1",
    useKnowledge: false,
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    description: "Responde com base nos artigos da Wikipedia instalados e cita as fontes.",
    systemPromptId: "rag-system@1",
    useKnowledge: true,
  },
];

/** Disponibilidade de cada agente: sem base de conhecimento com trechos, `wikipedia` fica indisponível. */
export function listAgents(knowledgeInstalled: boolean): AgentInfo[] {
  return AGENTS.map((agent) => {
    const needsKnowledge = agent.useKnowledge && !knowledgeInstalled;
    return {
      ...agent,
      available: !needsKnowledge,
      ...(needsKnowledge ? { reason: "instale uma base em Configurações → Base de conhecimento" } : {}),
      requirements: agent.useKnowledge ? "um modelo instalado e uma base de conhecimento" : "um modelo instalado",
    };
  });
}

export function findAgent(id: string, knowledgeInstalled: boolean): AgentInfo | undefined {
  return listAgents(knowledgeInstalled).find((agent) => agent.id === id);
}
