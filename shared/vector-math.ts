// Matemática de vetores sem biblioteca (puro: usado no Main, no Renderer e nos testes).

/**
 * Similaridade de cosseno: (A · B) / (|A| × |B|), em [-1, 1].
 * Vetor nulo não tem direção: devolve 0 (sem relação) em vez de NaN.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`Dimensões diferentes: ${a.length} × ${b.length}.`);
  if (a.length === 0) throw new Error("Vetores vazios.");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Erro de ponto flutuante pode passar levemente de ±1.
  return Math.min(1, Math.max(-1, cos));
}

/** Norma euclidiana |A|. */
export function norm(a: readonly number[]): number {
  let sum = 0;
  for (const x of a) sum += x * x;
  return Math.sqrt(sum);
}
