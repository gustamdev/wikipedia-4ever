// Embeddings (Semana 5): contratos entre Main e Renderer.

export type EmbeddingMode = "query" | "passage";

/** Código no início da mensagem de erro quando o modelo não está instalado (o engine nunca baixa sozinho). */
export type EmbeddingErrorCode = "EMBEDDING_MODEL_NOT_INSTALLED";

export interface EmbeddingStatus {
  installed: boolean;
  loaded: boolean;
  /** Carregando para a memória agora (primeiro uso leva alguns segundos). */
  loading: boolean;
  installing: boolean;
  modelId: string;
  dimensions: number;
  /** Precisão dos pesos ONNX (ex.: "q8"). */
  dtype: string;
  /** Tamanho real em disco dos arquivos instalados; null se não instalado. */
  sizeBytes: number | null;
}

export interface EmbeddingInstallProgress {
  file: string;
  loaded: number;
  total: number;
}

export interface SimilarityResult {
  score: number;
  ms: number;
}

export type SimilarityExpectation = "high" | "low";

export interface SimilarityTestPair {
  a: string;
  b: string;
  expected: SimilarityExpectation;
}

/** Pares do laboratório (Semana 5). Cada "high" deve pontuar acima do "low" com a mesma frase A. */
export const SIMILARITY_TEST_PAIRS: readonly SimilarityTestPair[] = [
  { a: "Quem foi Albert Einstein?", b: "Einstein foi um físico teórico alemão", expected: "high" },
  { a: "Quem foi Albert Einstein?", b: "Receita de bolo de chocolate", expected: "low" },
  { a: "Quem inventou a lâmpada?", b: "A lâmpada elétrica foi desenvolvida por Thomas Edison", expected: "high" },
  { a: "Quem inventou a lâmpada?", b: "O campeonato brasileiro de futebol tem vinte times", expected: "low" },
  { a: "Qual a capital da França?", b: "Paris é a capital e maior cidade da França", expected: "high" },
  { a: "Qual a capital da França?", b: "O futebol é o esporte mais popular do Brasil", expected: "low" },
  { a: "How does photosynthesis work?", b: "A fotossíntese converte luz em energia química", expected: "high" },
  { a: "How does photosynthesis work?", b: "O preço do café subiu no mercado internacional", expected: "low" },
];
