// Agentes: perfis que definem como o chat responde (prompt de sistema, uso de base, modelo preferido).

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /** Chave em PROMPTS (electron/agents/prompts.ts), no formato `<id>@<versão>`. */
  systemPromptId: string;
  /** true a partir da Semana 9 (RAG). */
  useKnowledge: boolean;
  preferredModelId?: string;
}

export interface AgentInfo extends AgentDefinition {
  available: boolean;
  /** Por que está indisponível (exibido como dica). */
  reason?: string;
  /** Requisitos em texto para Configurações → Agentes. */
  requirements: string;
}

export const DEFAULT_AGENT_ID = "assistant";
