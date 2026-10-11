import { useState } from "react";
import type { ActiveModel, ModelListItem } from "../../shared/models";
import { Spinner } from "../ui/Spinner";
import { StatusTag } from "../ui/StatusTag";
import { Tooltip } from "../ui/Tooltip";

interface ModelSelectorProps {
  models: ModelListItem[] | null;
  active: ActiveModel | null;
}

/** Seletor do header: troca o modelo carregado sem reiniciar (a conversa é mantida). */
export function ModelSelector({ models, active }: ModelSelectorProps) {
  const [error, setError] = useState<string | null>(null);
  const installed = models?.filter((m) => m.status.state === "installed") ?? [];
  const value = active?.id ?? "";

  return (
    <span className="picker">
      <label className="picker__label" htmlFor="model-picker">
        modelo:
      </label>
      <select
        id="model-picker"
        className="picker__select"
        value={value}
        disabled={installed.length === 0}
        onChange={(event) => {
          setError(null);
          if (event.target.value) {
            window.electronAPI.models.load(event.target.value).catch((e: unknown) => {
              // Uma troca mais nova cancela a anterior: não é erro para o usuário.
              const message = e instanceof Error ? e.message : String(e);
              if (!message.includes("outro modelo foi escolhido")) setError(message);
            });
          }
        }}
      >
        {value === "" && <option value="">{active?.name ?? (installed.length ? "escolha um modelo" : "nenhum instalado")}</option>}
        {installed.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {active?.state === "loading" && (
        <span className="picker__state">
          <Spinner label="carregando modelo" /> carregando…
        </span>
      )}
      {active?.state === "ready" && <StatusTag tone="ok">pronto</StatusTag>}
      {(active?.state === "error" || error) && (
        <Tooltip text={error ?? active?.error ?? "erro"}>
          <StatusTag tone="danger">erro</StatusTag>
        </Tooltip>
      )}
    </span>
  );
}
