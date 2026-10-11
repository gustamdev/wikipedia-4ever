import { useEffect, useMemo, useState } from "react";
import type { EmbeddingInstallProgress, EmbeddingStatus } from "../../../shared/embeddings";
import type {
  DatasetLanguage,
  IngestionEstimate,
  IngestionProgress,
  IngestionStatus,
  IngestionSummary,
  KnowledgeBase,
} from "../../../shared/ingestion";
import { formatBytes, formatEta, formatSpeed } from "../../lib/format";
import { useIngestion } from "../../lib/useIngestion";
import { Button } from "../../ui/Button";
import { Panel } from "../../ui/Panel";
import { ProgressBar } from "../../ui/ProgressBar";
import { Spinner } from "../../ui/Spinner";
import { ErrorState } from "../../ui/States";
import { StatusTag } from "../../ui/StatusTag";

const integer = new Intl.NumberFormat("pt-BR");
const DEFAULT_LANGUAGE = "simple";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

let displayNames: Intl.DisplayNames | null = null;
/** "Português (pt)". Códigos que o Intl não conhece aparecem só como código. */
function languageLabel(code: string): string {
  if (code === "simple") return "Inglês simples (simple)";
  try {
    displayNames ??= new Intl.DisplayNames(["pt-BR"], { type: "language" });
    const name = displayNames.of(code);
    return name && name !== code ? `${name.charAt(0).toUpperCase()}${name.slice(1)} (${code})` : code;
  } catch {
    return code;
  }
}

function stageLine(p: IngestionProgress): string {
  if (p.stage === "download") {
    const file = p.file ? ` · ${p.file}` : "";
    if (p.verifying) return `Conferindo integridade (SHA-256)…${file}`;
    return `Baixando: ${formatBytes(p.current)} de ${formatBytes(p.total)} · ${formatSpeed(p.bytesPerSecond ?? 0)} · ETA ${formatEta(p.etaSeconds)}${file}`;
  }
  if (p.stage === "embed") {
    return `Gerando embeddings: ${integer.format(p.current)} / ${integer.format(p.total)} artigos · ${integer.format(p.chunks)} trechos · ETA ${formatEta(p.etaSeconds)}`;
  }
  return "Criando índice de busca…";
}

function EmbeddingModelPanel({ status, onChanged }: { status: EmbeddingStatus; onChanged: () => void }) {
  const [files, setFiles] = useState<Record<string, EmbeddingInstallProgress>>({});
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => window.electronAPI.embeddings.onInstallProgress((p) => setFiles((c) => ({ ...c, [p.file]: p }))), []);

  const progress = Object.values(files);
  const loaded = progress.reduce((sum, p) => sum + p.loaded, 0);
  const total = progress.reduce((sum, p) => sum + p.total, 0);
  const busy = installing || status.installing;

  const install = () => {
    setError(null);
    setFiles({});
    setInstalling(true);
    window.electronAPI.embeddings
      .install()
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => {
        setInstalling(false);
        onChanged();
      });
  };

  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Modelo de embeddings</span>
        <StatusTag tone="warn">não instalado</StatusTag>
      </div>
      <div className="model__meta">
        {status.modelId} · ~135 MB · transforma cada trecho da Wikipedia em um vetor para a busca. Necessário antes de indexar.
      </div>
      {busy && (
        <div className="model__progress">
          <ProgressBar value={total ? loaded / total : 0} />
          <span>
            {formatBytes(loaded)}
            {total ? ` de ${formatBytes(total)}` : ""}
          </span>
        </div>
      )}
      {error && <div className="model__error" role="alert">{error}</div>}
      <div className="model__actions">
        <Button variant="primary" disabled={busy} onClick={install}>
          {busy ? "Baixando…" : "Baixar modelo de embeddings"}
        </Button>
      </div>
    </Panel>
  );
}

function SummaryPanel({ summary }: { summary: IngestionSummary }) {
  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Indexação concluída · {languageLabel(summary.language)}</span>
        <StatusTag tone="ok">completa</StatusTag>
      </div>
      <div className="model__meta">
        {integer.format(summary.articles)} artigos · {integer.format(summary.chunks)} trechos ·{" "}
        {integer.format(summary.vectors)} vetores na base · {formatBytes(summary.sizeOnDiskBytes)} em disco
      </div>
      <div className="model__meta">
        {formatEta(Math.round(summary.elapsedMs / 1000))} de trabalho · {integer.format(summary.chunksPerSecond)} trechos/s
      </div>
      {summary.truncatedChunks > 0 && (
        <div className="model__meta">
          {integer.format(summary.truncatedChunks)} trechos passaram do limite do modelo de embeddings: o fim deles não entra na busca.
        </div>
      )}
    </Panel>
  );
}

function RunningPanel({ status, progress }: { status: IngestionStatus; progress: IngestionProgress | null }) {
  const [error, setError] = useState<string | null>(null);
  const canceling = status.state === "canceling";
  const cancel = () => window.electronAPI.ingestion.cancel().catch((e: unknown) => setError(messageOf(e)));
  const ratio = progress && progress.total > 0 ? progress.current / progress.total : 0;
  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Indexando {status.language ? languageLabel(status.language) : ""}</span>
        <StatusTag tone="accent">{canceling ? "cancelando" : "em andamento"}</StatusTag>
      </div>
      {progress ? (
        <>
          <div className="model__progress">
            <ProgressBar value={ratio} />
            <span>{stageLine(progress)}</span>
          </div>
          <div className="model__meta">
            Etapa {progress.stage === "download" ? "1" : progress.stage === "embed" ? "2" : "3"} de 3 (baixar → embutir e gravar → indexar) ·{" "}
            {formatEta(Math.round(progress.elapsedMs / 1000))} de trabalho
          </div>
        </>
      ) : (
        <div className="model__progress">
          <Spinner label="iniciando" /> <span>iniciando…</span>
        </div>
      )}
      <div className="model__meta">
        Pode navegar e conversar enquanto isso; o app fica mais lento. Se cancelar ou fechar o app, o que já foi indexado continua
        utilizável e dá para retomar.
      </div>
      {error && <div className="model__error" role="alert">{error}</div>}
      <div className="model__actions">
        <Button disabled={canceling} onClick={cancel}>
          {canceling ? "Cancelando…" : "Cancelar"}
        </Button>
      </div>
    </Panel>
  );
}

function EstimateView({ estimate }: { estimate: IngestionEstimate }) {
  const approx = estimate.estimateBasis === "rough" ? "grosseira (idioma ainda não medido)" : "baseada em medições";
  return (
    <div className="model__meta">
      <div>
        Download dos Parquets: {formatBytes(estimate.rawBytes)} (exato)
        {estimate.alreadyDownloadedBytes > 0 && ` · já no disco: ${formatBytes(estimate.alreadyDownloadedBytes)}`}
      </div>
      <div>
        Vetores e texto: ~{formatBytes(estimate.estimatedVectorBytes)} · índice: ~{formatBytes(estimate.estimatedIndexBytes)} (estimativas)
      </div>
      <div>
        ≈ {integer.format(estimate.articlesApprox)} artigos e ≈ {integer.format(estimate.chunksApprox)} trechos (estimativa {approx})
      </div>
      <div>
        Espaço necessário: ~{formatBytes(estimate.totalBytes)} · livre: {formatBytes(estimate.freeBytes)}{" "}
        <StatusTag tone={estimate.sufficient ? "ok" : "danger"}>{estimate.sufficient ? "✓ cabe" : "✕ espaço insuficiente"}</StatusTag>
      </div>
    </div>
  );
}

function ChooseAndStart({
  bases,
  interrupted,
  onStarted,
}: {
  bases: KnowledgeBase[];
  /** Idioma de uma indexação interrompida (só uma pode ser retomada por vez). */
  interrupted: string | null;
  onStarted: () => void;
}) {
  const [languages, setLanguages] = useState<DatasetLanguage[] | null>(null);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [estimate, setEstimate] = useState<IngestionEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [deleteRaw, setDeleteRaw] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.ingestion
      .languages()
      .then(setLanguages)
      .catch((e: unknown) => setError(`Não foi possível listar os idiomas (é preciso internet): ${messageOf(e)}`));
  }, []);

  useEffect(() => {
    let current = true;
    setEstimate(null);
    setEstimating(true);
    window.electronAPI.ingestion
      .estimate(language)
      .then((e) => current && (setEstimate(e), setError(null)))
      .catch((e: unknown) => current && setError(`Não foi possível estimar o espaço: ${messageOf(e)}`))
      .finally(() => current && setEstimating(false));
    return () => {
      current = false;
    };
  }, [language]);

  const existing = bases.find((b) => b.language === language);
  const options = useMemo(() => languages ?? [{ code: DEFAULT_LANGUAGE, snapshot: "" }], [languages]);

  const start = () => {
    setError(null);
    setStarting(true);
    window.electronAPI.ingestion
      .start(language, { deleteRaw })
      .then(onStarted)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setStarting(false));
  };

  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Nova indexação</span>
      </div>
      <label className="picker">
        <span className="picker__label">Idioma da Wikipedia</span>{" "}
        <select className="picker__select" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={starting}>
          {options.map((l) => (
            <option key={l.code} value={l.code}>
              {languageLabel(l.code)}
            </option>
          ))}
        </select>
      </label>
      {estimating && (
        <div className="model__progress">
          <Spinner label="estimando" /> <span>calculando espaço…</span>
        </div>
      )}
      {estimate && <EstimateView estimate={estimate} />}
      {existing && (
        <div className="model__meta">
          Já existe uma base deste idioma ({integer.format(existing.chunks)} trechos, {existing.status === "complete" ? "completa" : "parcial"}):
          continuar apaga e recomeça do zero.
        </div>
      )}
      {interrupted && interrupted !== language && (
        <div className="model__meta">
          Iniciar esta indexação descarta a retomada de {languageLabel(interrupted)} (o que já foi indexado de lá continua utilizável).
        </div>
      )}
      <label className="model__meta">
        <input type="checkbox" checked={deleteRaw} onChange={(e) => setDeleteRaw(e.target.checked)} disabled={starting} /> Apagar os
        arquivos brutos (Parquet) depois de indexar
      </label>
      {error && <div className="model__error" role="alert">{error}</div>}
      <div className="model__actions">
        <Button variant="primary" disabled={!estimate || !estimate.sufficient || starting} onClick={start}>
          {starting ? "Iniciando…" : "Continuar"}
        </Button>
      </div>
    </Panel>
  );
}

function InterruptedPanel({ status, bases }: { status: IngestionStatus; bases: KnowledgeBase[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = bases.find((b) => b.language === status.language);
  const resume = () => {
    setError(null);
    setBusy(true);
    window.electronAPI.ingestion
      .resume()
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Indexação interrompida · {status.language ? languageLabel(status.language) : ""}</span>
        <StatusTag tone={status.state === "error" ? "danger" : "warn"}>{status.state === "error" ? "erro" : "parcial"}</StatusTag>
      </div>
      {base && (
        <div className="model__meta">
          Já indexado e utilizável: {integer.format(base.documents)} artigos · {integer.format(base.chunks)} trechos ·{" "}
          {formatBytes(base.sizeOnDiskBytes)}
        </div>
      )}
      {status.error && <div className="model__error" role="alert">{status.error}</div>}
      {error && <div className="model__error" role="alert">{error}</div>}
      <div className="model__actions">
        <Button variant="primary" disabled={busy} onClick={resume}>
          {busy ? "Retomando…" : "Retomar"}
        </Button>
      </div>
      <div className="model__meta">Para recomeçar do zero (apaga a base deste idioma), inicie uma nova indexação abaixo.</div>
    </Panel>
  );
}

export function KnowledgeSection() {
  const { status, progress, bases, error, refresh } = useIngestion();
  const [embedding, setEmbedding] = useState<EmbeddingStatus | null>(null);

  const refreshEmbedding = () => {
    window.electronAPI.embeddings.status().then(setEmbedding).catch(() => setEmbedding(null));
  };
  useEffect(refreshEmbedding, []);

  if (error) {
    return <ErrorState title="Não foi possível carregar a base de conhecimento" hint={error} action={<Button onClick={refresh}>Tentar novamente</Button>} />;
  }
  if (!status || !embedding) {
    return (
      <div className="state">
        <span>
          <Spinner /> carregando…
        </span>
      </div>
    );
  }

  const active = status.state === "running" || status.state === "canceling";
  const interrupted = (status.state === "partial" || status.state === "error") && status.resumable;
  return (
    <section className="models" aria-label="Base de conhecimento">
      <p className="section__hint">
        Indexa a Wikipedia no seu computador para o assistente buscar nela, sem internet. Escolha o idioma, confira o espaço e
        continue: o download e a indexação rodam em um processo separado e podem ser retomados.
      </p>
      {!embedding.installed && <EmbeddingModelPanel status={embedding} onChanged={refreshEmbedding} />}
      {active && <RunningPanel status={status} progress={progress} />}
      {interrupted && <InterruptedPanel status={status} bases={bases} />}
      {status.state === "completed" && status.summary && <SummaryPanel summary={status.summary} />}
      {status.state === "error" && !interrupted && status.error && <ErrorState title="A indexação falhou" hint={status.error} />}
      {!active && embedding.installed && <ChooseAndStart bases={bases} interrupted={interrupted ? status.language : null} onStarted={refresh} />}
    </section>
  );
}
