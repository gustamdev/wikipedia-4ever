import type { AgentInfo } from "../../../shared/agents";
import { Panel } from "../../ui/Panel";
import { Spinner } from "../../ui/Spinner";
import { StatusTag } from "../../ui/StatusTag";

/** Lista só leitura dos agentes embutidos (agentes do usuário: fora do escopo por ora). */
export function AgentsSection({ agents }: { agents: AgentInfo[] | null }) {
  if (!agents) {
    return (
      <div className="state">
        <span>
          <Spinner /> carregando agentes…
        </span>
      </div>
    );
  }
  return (
    <section className="models" aria-label="Agentes">
      <p className="section__hint">
        Um agente define como o chat responde. Escolha no topo da tela do chat; a troca vale a partir da próxima resposta
        e a conversa é mantida.
      </p>
      {agents.map((agent) => (
        <Panel key={agent.id} className="model">
          <div className="model__head">
            <span className="model__name">{agent.name}</span>
            <StatusTag tone={agent.available ? "ok" : "neutral"}>{agent.available ? "disponível" : "indisponível"}</StatusTag>
          </div>
          <div className="model__meta">{agent.description}</div>
          <div className="model__meta">Requer: {agent.requirements}.</div>
          {!agent.available && agent.reason && <div className="model__meta">Para usar: {agent.reason}.</div>}
        </Panel>
      ))}
    </section>
  );
}
