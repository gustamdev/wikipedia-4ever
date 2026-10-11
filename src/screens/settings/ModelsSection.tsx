import { useState } from "react";
import type { ModelListItem } from "../../../shared/models";
import { recommendModel, type HardwareInfo, type ModelFit } from "../../../shared/system";
import { formatBytes, formatEta, formatRam, formatSpeed } from "../../lib/format";
import type { ModelsState } from "../../lib/useModels";
import { Button } from "../../ui/Button";
import { Panel } from "../../ui/Panel";
import { ProgressBar } from "../../ui/ProgressBar";
import { Spinner } from "../../ui/Spinner";
import { EmptyState, ErrorState } from "../../ui/States";
import { StatusTag, type Tone } from "../../ui/StatusTag";
import { Tooltip } from "../../ui/Tooltip";

const STATE_LABEL: Record<ModelListItem["status"]["state"], [string, Tone]> = {
  not_installed: ["não instalado", "neutral"],
  queued: ["na fila", "neutral"],
  downloading: ["baixando", "accent"],
  paused: ["pausado", "warn"],
  verifying: ["verificando", "accent"],
  installed: ["instalado", "ok"],
  error: ["erro", "danger"],
};

const FIT: Record<ModelFit, [string, Tone, string]> = {
  recommended: ["✓ recomendado", "ok", "roda com folga"],
  tight: ["⚠ apertado", "warn", "possível, mas pode ficar lento ou faltar memória com outros programas abertos"],
  not_recommended: ["✕ não recomendado", "danger", "a memória provavelmente não é suficiente"],
};

type Action = "install" | "pause" | "resume" | "cancel" | "remove" | "setDefault";

function FitTag({ model, hardware }: { model: ModelListItem; hardware: HardwareInfo }) {
  const [label, tone, why] = FIT[recommendModel(model, hardware)];
  const text = `Seu computador tem ${formatRam(hardware.totalRamBytes)} de RAM; este modelo pede ~${formatRam(model.recommendedRamBytes)}: ${why}.`;
  return (
    <Tooltip text={text} align="end">
      <StatusTag tone={tone}>{label}</StatusTag>
    </Tooltip>
  );
}

function ModelRow({ model, hardware }: { model: ModelListItem; hardware: HardwareInfo | null }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const { status } = model;
  const [label, tone] = STATE_LABEL[status.state];

  const run = (action: Action) => {
    setActionError(null);
    setBusy(true);
    window.electronAPI.models[action](model.id)
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        setConfirmRemove(false);
      });
  };

  const downloaded = status.bytesDownloaded ?? 0;
  const ofTotal = `${formatBytes(downloaded)} de ${formatBytes(model.sizeBytes)}`;

  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">{model.name}</span>
        <span className="model__tags">
          {model.isDefault && <StatusTag tone="accent">padrão</StatusTag>}
          <StatusTag tone={tone}>{label}</StatusTag>
          {hardware && <FitTag model={model} hardware={hardware} />}
        </span>
      </div>
      <div className="model__meta">
        {model.developer} · {formatBytes(model.sizeBytes)} · {model.quantization} · licença{" "}
        <a href={model.licenseUrl} target="_blank" rel="noreferrer">
          {model.license}
        </a>
      </div>
      <div className="model__meta">{model.licenseSummary}</div>

      {status.state === "downloading" && (
        <div className="model__progress">
          <ProgressBar value={status.progress ?? 0} />
          <span>
            {formatSpeed(status.bytesPerSecond ?? 0)} · ETA {formatEta(status.etaSeconds)} · {ofTotal}
          </span>
        </div>
      )}
      {status.state === "paused" && (
        <div className="model__progress">
          <ProgressBar value={status.progress ?? 0} />
          <span>{ofTotal}</span>
        </div>
      )}
      {status.state === "verifying" && (
        <div className="model__progress">
          <ProgressBar value={status.progress ?? 0} />
          <span>
            <Spinner label="verificando" /> conferindo integridade (SHA-256)…
          </span>
        </div>
      )}
      {status.error && <div className="model__error" role="alert">{status.error}</div>}
      {actionError && <div className="model__error" role="alert">{actionError}</div>}

      <div className="model__actions">
        {status.state === "not_installed" && (
          <Button variant="primary" onClick={() => run("install")}>
            Instalar
          </Button>
        )}
        {(status.state === "downloading" || status.state === "queued") && (
          <Button onClick={() => run("pause")}>Pausar</Button>
        )}
        {status.state === "paused" && (
          <Button variant="primary" onClick={() => run("resume")}>
            Retomar
          </Button>
        )}
        {status.state === "error" && (
          <Button variant="primary" onClick={() => run("resume")}>
            Tentar novamente
          </Button>
        )}
        {status.state !== "not_installed" && status.state !== "installed" && (
          <Button variant="ghost" onClick={() => run("cancel")}>
            Cancelar
          </Button>
        )}
        {status.state === "installed" && !model.isDefault && !confirmRemove && (
          <Button disabled={busy} onClick={() => run("setDefault")}>
            Definir como padrão
          </Button>
        )}
        {status.state === "installed" && !confirmRemove && (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remover
          </Button>
        )}
        {confirmRemove && (
          <>
            <span className="model__confirm">Apagar {formatBytes(model.sizeBytes)} do disco?</span>
            <Button disabled={busy} onClick={() => run("remove")}>
              {busy ? "Removendo…" : "Sim, remover"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
              Não
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

function HardwareSummary({ hardware, error }: { hardware: HardwareInfo | null; error: string | null }) {
  if (error) return <p className="hw">Não foi possível detectar o hardware ({error}); a recomendação ✓/⚠/✕ fica indisponível.</p>;
  if (!hardware) return <p className="hw"><Spinner /> detectando hardware…</p>;
  return (
    <p className="hw">
      {/* Sem "RAM livre": no macOS os.freemem() ignora o cache e mostra ~0 GB, o que engana. */}
      Seu computador: {formatRam(hardware.totalRamBytes)} de RAM ·{" "}
      {hardware.cpuCores} núcleos ({hardware.cpuModel}) · {formatBytes(hardware.freeDiskBytes)} livres em disco
    </p>
  );
}

interface ModelsSectionProps {
  state: ModelsState;
  hardware: HardwareInfo | null;
  hardwareError: string | null;
}

export function ModelsSection({ state, hardware, hardwareError }: ModelsSectionProps) {
  const { models, error, reload } = state;
  if (error) {
    return (
      <ErrorState
        title="Não foi possível carregar os modelos"
        hint={error}
        action={<Button onClick={reload}>Tentar novamente</Button>}
      />
    );
  }
  if (!models) {
    return (
      <div className="state">
        <span>
          <Spinner /> carregando modelos…
        </span>
      </div>
    );
  }
  if (models.length === 0) {
    return <EmptyState title="Nenhum modelo no catálogo" hint="O catálogo fica em electron/models/catalog.ts." />;
  }
  return (
    <section className="models" aria-label="Modelos">
      <p className="section__hint">
        Modelos de linguagem que rodam no seu computador. Depois de instalados, funcionam sem internet. Um download por
        vez; os demais aguardam na fila. O modelo padrão é carregado ao abrir o app.
      </p>
      <HardwareSummary hardware={hardware} error={hardwareError} />
      {models.map((model) => (
        <ModelRow key={model.id} model={model} hardware={hardware} />
      ))}
    </section>
  );
}
