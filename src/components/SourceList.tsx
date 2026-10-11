import type { RagSource } from "../../shared/rag";

const score = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Fontes de uma resposta com RAG: `[n] Título — Seção (0,83)`, expansível para o trecho local.
 * O trecho é texto puro (React escapa; nada de HTML vindo da base). O link abre no navegador.
 */
export function SourceList({ sources }: { sources: RagSource[] }) {
  if (sources.length === 0) {
    return <div className="sources">fontes: nenhum trecho relevante na base</div>;
  }
  return (
    <div className="sources">
      <span className="sources__label">fontes:</span>
      <ol className="sources__list">
        {sources.map((source, i) => (
          <li key={source.chunk_id}>
            <details className="source">
              <summary className="source__summary">
                [{i + 1}] {source.document_title}
                {source.section ? ` — ${source.section}` : ""} ({score.format(source.score)})
              </summary>
              <div className="source__body">
                <p className="source__text">{source.text}</p>
                <button type="button" className="link-action" onClick={() => void window.electronAPI.app.openExternal(source.url)}>
                  abrir artigo ↗
                </button>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
