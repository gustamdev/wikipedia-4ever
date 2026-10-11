import { useCallback, useEffect, useState } from "react";
import type { VectorSearchResponse, VectorStoreInfo } from "../../../shared/chunk";
import { SIMILARITY_TEST_PAIRS, type EmbeddingInstallProgress, type EmbeddingStatus } from "../../../shared/embeddings";
import { formatBytes } from "../../lib/format";
import { Button } from "../../ui/Button";
import { Panel } from "../../ui/Panel";
import { ProgressBar } from "../../ui/ProgressBar";
import { Spinner } from "../../ui/Spinner";
import { ErrorState } from "../../ui/States";
import { StatusTag } from "../../ui/StatusTag";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
}

const score = (n: number) => n.toFixed(4);

interface PairResult {
  a: string;
  b: string;
  expected: "high" | "low";
  score: number;
  ms: number;
}

/** Laboratório de similaridade (Semana 5). Só aparece em dev (`import.meta.env.DEV`). */
export function DevSection() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, EmbeddingInstallProgress>>({});
  const [installing, setInstalling] = useState(false);
  const [a, setA] = useState("Quem foi Albert Einstein?");
  const [b, setB] = useState("Einstein foi um físico teórico alemão");
  const [busy, setBusy] = useState<"compare" | "pairs" | null>(null);
  const [result, setResult] = useState<{ score: number; ms: number } | null>(null);
  const [pairs, setPairs] = useState<PairResult[] | null>(null);

  const refresh = useCallback(() => {
    window.electronAPI.embeddings
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(messageOf(e)));
  }, []);

  useEffect(() => {
    refresh();
    return window.electronAPI.embeddings.onInstallProgress((p) => setFiles((current) => ({ ...current, [p.file]: p })));
  }, [refresh]);

  const install = () => {
    setError(null);
    setFiles({});
    setInstalling(true);
    window.electronAPI.embeddings
      .install()
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => {
        setInstalling(false);
        refresh();
      });
  };

  // Primeira comparação carrega o modelo (alguns segundos): o status mostra "carregando".
  const withLoad = async <T,>(kind: "compare" | "pairs", work: () => Promise<T>) => {
    setError(null);
    setBusy(kind);
    if (status && !status.loaded) setStatus({ ...status, loading: true });
    try {
      return await work();
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const compare = () =>
    void withLoad("compare", async () => setResult(await window.electronAPI.embeddings.similarity(a, b)));

  const runPairs = () =>
    void withLoad("pairs", async () => {
      const out: PairResult[] = [];
      for (const pair of SIMILARITY_TEST_PAIRS) {
        const r = await window.electronAPI.embeddings.similarity(pair.a, pair.b);
        out.push({ ...pair, ...r });
        setPairs([...out]);
      }
    });

  if (!status && !error) {
    return (
      <div className="state">
        <span>
          <Spinner /> verificando o modelo de embeddings…
        </span>
      </div>
    );
  }
  if (!status) return <ErrorState title="Não foi possível consultar os embeddings" hint={error} action={<Button onClick={refresh}>Tentar novamente</Button>} />;

  const progress = Object.values(files);
  const loaded = progress.reduce((sum, p) => sum + p.loaded, 0);
  const total = progress.reduce((sum, p) => sum + p.total, 0);

  return (
    <section className="models" aria-label="Laboratório de embeddings">
      <p className="section__hint">Ferramentas de desenvolvimento. Esta seção não aparece no app empacotado.</p>

      <Panel className="model">
        <div className="model__head">
          <span className="model__name">Embeddings · {status.modelId}</span>
          <StatusTag tone={status.installed ? "ok" : "neutral"}>{status.installed ? "instalado" : "não instalado"}</StatusTag>
        </div>
        <div className="model__meta">
          {status.dimensions} dimensões · pesos {status.dtype}
          {status.sizeBytes !== null && ` · ${formatBytes(status.sizeBytes)} em disco`}
          {status.loaded ? " · na memória" : status.loading ? " · carregando…" : ""}
        </div>
        {(installing || status.installing) && (
          <div className="model__progress">
            <ProgressBar value={total ? loaded / total : 0} />
            <span>
              {formatBytes(loaded)}
              {total ? ` de ${formatBytes(total)}` : ""}
            </span>
            {progress.length > 0 && <span>{progress[progress.length - 1].file}</span>}
          </div>
        )}
        {!status.installed && (
          <div className="model__actions">
            <Button variant="primary" disabled={installing || status.installing} onClick={install}>
              {installing || status.installing ? "Baixando…" : "Baixar modelo de embeddings"}
            </Button>
          </div>
        )}
      </Panel>

      {error && <div className="model__error" role="alert">✕ {error}</div>}

      {status.installed && (
        <>
          <Panel className="model">
            <span className="model__name">Comparar dois textos</span>
            <label className="model__meta" htmlFor="lab-a">
              Texto A
            </label>
            <textarea id="lab-a" className="lab__input" rows={2} value={a} onChange={(e) => setA(e.target.value)} />
            <label className="model__meta" htmlFor="lab-b">
              Texto B
            </label>
            <textarea id="lab-b" className="lab__input" rows={2} value={b} onChange={(e) => setB(e.target.value)} />
            <div className="model__actions">
              <Button variant="primary" disabled={busy !== null || !a.trim() || !b.trim()} onClick={compare}>
                Comparar
              </Button>
              {busy === "compare" && (
                <span className="model__meta">
                  <Spinner /> {status.loaded ? "calculando…" : "carregando o modelo (primeira vez)…"}
                </span>
              )}
            </div>
            {result && (
              <div className="model__meta">
                score {score(result.score)} · {result.ms} ms
              </div>
            )}
          </Panel>

          <Panel className="model">
            <span className="model__name">Pares de teste</span>
            <div className="model__meta">Cada par "alto" deve pontuar acima do "baixo" com a mesma frase A.</div>
            <div className="model__actions">
              <Button disabled={busy !== null} onClick={runPairs}>
                Rodar pares de teste
              </Button>
              {busy === "pairs" && (
                <span className="model__meta">
                  <Spinner /> {status.loaded ? `${pairs?.length ?? 0}/${SIMILARITY_TEST_PAIRS.length}` : "carregando o modelo…"}
                </span>
              )}
            </div>
            {pairs && pairs.length > 0 && (
              <div className="lab__table-wrap">
                <table className="lab__table">
                  <thead>
                    <tr>
                      <th>A</th>
                      <th>B</th>
                      <th>esperado</th>
                      <th>score</th>
                      <th>ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairs.map((p) => (
                      <tr key={`${p.a}|${p.b}`}>
                        <td>{p.a}</td>
                        <td>{p.b}</td>
                        <td>{p.expected === "high" ? "alto" : "baixo"}</td>
                        <td>{score(p.score)}</td>
                        <td>{p.ms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {pairs && pairs.length === SIMILARITY_TEST_PAIRS.length && <PairsVerdict pairs={pairs} />}
          </Panel>

          <VectorLab />
        </>
      )}
    </section>
  );
}

/** Critério 1 da Semana 5: por frase A, alto > baixo; e média dos altos > média dos baixos. */
function PairsVerdict({ pairs }: { pairs: PairResult[] }) {
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const highs = pairs.filter((p) => p.expected === "high");
  const lows = pairs.filter((p) => p.expected === "low");
  const perA = highs.every((h) => lows.filter((l) => l.a === h.a).every((l) => h.score > l.score));
  const ok = perA && mean(highs.map((p) => p.score)) > mean(lows.map((p) => p.score));
  return (
    <div className="model__meta">
      <StatusTag tone={ok ? "ok" : "danger"}>{ok ? "passou" : "falhou"}</StatusTag> média alto {score(mean(highs.map((p) => p.score)))} · média
      baixo {score(mean(lows.map((p) => p.score)))}
    </div>
  );
}

/** Busca vetorial de teste (Semana 6): dados de teste, pergunta, top-K, resultados e tempos. */
function VectorLab() {
  const [info, setInfo] = useState<VectorStoreInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "clear" | "search" | null>(null);
  const [query, setQuery] = useState("Como surgiu a teoria da relatividade?");
  const [topK, setTopK] = useState(5);
  const [response, setResponse] = useState<VectorSearchResponse | null>(null);

  const refresh = useCallback(() => {
    window.electronAPI.vector
      .info()
      .then(setInfo)
      .catch((e: unknown) => setError(messageOf(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const run = (kind: "load" | "clear" | "search", work: () => Promise<unknown>) => {
    setError(null);
    setBusy(kind);
    work()
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  return (
    <Panel className="model">
      <div className="model__head">
        <span className="model__name">Busca vetorial (LanceDB)</span>
        {info && <StatusTag tone={info.indexed ? "ok" : "neutral"}>{info.indexed ? "índice ANN" : "busca exata"}</StatusTag>}
      </div>
      <div className="model__meta">
        {info
          ? `${info.rows} linhas · ${formatBytes(info.sizeOnDiskBytes)} em disco · ${info.embeddingModel} (${info.dimensions}) · ${info.engine}`
          : "abrindo a base…"}
      </div>
      <div className="model__actions">
        <Button disabled={busy !== null} onClick={() => run("load", () => window.electronAPI.vector.loadTestData())}>
          {busy === "load" ? "Carregando…" : "Carregar dados de teste"}
        </Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => run("clear", () => window.electronAPI.vector.clearTestData())}>
          Limpar dados de teste
        </Button>
      </div>
      <label className="model__meta" htmlFor="lab-query">
        Pergunta
      </label>
      <textarea id="lab-query" className="lab__input" rows={2} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="model__actions">
        <label className="model__meta" htmlFor="lab-topk">
          top-K
        </label>
        <input
          id="lab-topk"
          className="lab__input"
          type="number"
          min={1}
          max={50}
          value={topK}
          onChange={(e) => setTopK(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
        />
        <Button
          variant="primary"
          disabled={busy !== null || !query.trim()}
          onClick={() => run("search", async () => setResponse(await window.electronAPI.vector.search(query, topK)))}
        >
          Buscar
        </Button>
        {busy && (
          <span className="model__meta">
            <Spinner /> {busy === "search" ? "buscando…" : "processando…"}
          </span>
        )}
      </div>
      {error && <div className="model__error" role="alert">✕ {error}</div>}
      {response && (
        <>
          <div className="model__meta">
            {response.results.length} resultados · embedding da pergunta {response.embedMs} ms · busca {response.searchMs} ms
          </div>
          {response.results.length > 0 && (
            <div className="lab__table-wrap">
              <table className="lab__table">
                <thead>
                  <tr>
                    <th>score</th>
                    <th>título</th>
                    <th>seção</th>
                    <th>trecho</th>
                  </tr>
                </thead>
                <tbody>
                  {response.results.map((r) => (
                    <tr key={r.chunk_id}>
                      <td>{score(r.score)}</td>
                      <td>{r.document_title}</td>
                      <td>{r.section ?? "(introdução)"}</td>
                      <td>{r.text.length > 140 ? `${r.text.slice(0, 140)}…` : r.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
