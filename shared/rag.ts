// RAG (Semana 9): parâmetros e fontes. Tipos puros, compartilhados Main ↔ Renderer.

export interface RagParams {
  /** Resultados pedidos ao vector store. */
  topK: number;
  /** Similaridade de cosseno mínima (e5): abaixo disso o trecho é descartado. */
  minScore: number;
  /** Trechos no máximo no prompt. */
  maxContextChunks: number;
  /** Fração do contexto do modelo reservada aos trechos. */
  contextBudgetRatio: number;
  /** Tokens deixados livres para a resposta. */
  answerReserveTokens: number;
}

/**
 * Defaults (a UI para mudá-los chega na Semana 10). `minScore` calibrado com perguntas reais
 * dentro e fora da base: ver relatório da Semana 9.
 */
export const DEFAULT_RAG_PARAMS: Readonly<RagParams> = Object.freeze({
  topK: 8,
  minScore: 0.81,
  maxContextChunks: 5,
  contextBudgetRatio: 0.5,
  answerReserveTokens: 512,
});

/** Um trecho que entrou no prompt, na ordem da citação (`[1]` = primeiro). */
export interface RagSource {
  chunk_id: string;
  document_title: string;
  section: string | null;
  url: string;
  text: string;
  score: number;
}
