import type { AgentInfo } from "../../shared/agents";
import { StatusTag } from "../ui/StatusTag";
import { Tooltip } from "../ui/Tooltip";

interface AgentSelectorProps {
  agents: AgentInfo[] | null;
  value: string;
  error?: string | null;
  onChange: (agentId: string) => void;
}

/** Trocar de agente vale para a próxima resposta; o histórico é mantido. */
export function AgentSelector({ agents, value, error, onChange }: AgentSelectorProps) {
  return (
    <span className="picker">
      <label className="picker__label" htmlFor="agent-picker">
        agente:
      </label>
      <select
        id="agent-picker"
        className="picker__select"
        value={value}
        disabled={!agents}
        onChange={(event) => onChange(event.target.value)}
      >
        {(agents ?? []).map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available} title={a.reason ?? a.description}>
            {a.available ? a.name : `${a.name} (${a.reason})`}
          </option>
        ))}
      </select>
      {error && (
        <Tooltip text={error}>
          <StatusTag tone="danger">erro</StatusTag>
        </Tooltip>
      )}
    </span>
  );
}
