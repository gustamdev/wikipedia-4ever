import type { AgentInfo } from "../../../shared/agents";
import { useHardware } from "../../lib/useHardware";
import type { ModelsState } from "../../lib/useModels";
import { Button } from "../../ui/Button";
import { AgentsSection } from "./AgentsSection";
import { DevSection } from "./DevSection";
import { KnowledgeSection } from "./KnowledgeSection";
import { ModelsSection } from "./ModelsSection";

// Seções entram conforme cada etapa é entregue (README → Interface).
export type SettingsSection = "models" | "knowledge" | "agents" | "dev";

// "Desenvolvedor" só existe em dev: o Vite remove o ramo (e o laboratório) do build de produção.
const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "models", label: "Modelos" },
  { id: "knowledge", label: "Base de conhecimento" },
  { id: "agents", label: "Agentes" },
  ...(import.meta.env.DEV ? [{ id: "dev" as const, label: "Desenvolvedor" }] : []),
];

interface SettingsScreenProps {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  models: ModelsState;
  agents: AgentInfo[] | null;
}

export function SettingsScreen({ section, onSelect, models, agents }: SettingsScreenProps) {
  const { hardware, error } = useHardware();
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Seções de configurações">
        {SECTIONS.map((s) => (
          <Button key={s.id} block variant="ghost" aria-current={s.id === section} onClick={() => onSelect(s.id)}>
            {s.label}
          </Button>
        ))}
      </nav>
      <div className="settings__content">
        <h1 className="settings__title">{SECTIONS.find((s) => s.id === section)?.label}</h1>
        {section === "models" && <ModelsSection state={models} hardware={hardware} hardwareError={error} />}
        {section === "knowledge" && <KnowledgeSection />}
        {section === "agents" && <AgentsSection agents={agents} />}
        {import.meta.env.DEV && section === "dev" && <DevSection />}
      </div>
    </div>
  );
}
