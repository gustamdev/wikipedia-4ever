// Schema do chunk: o mesmo que a ingestão (Semana 7) produz e o Vector Store (Semana 6) guarda.

export interface ChunkMetadata {
  /** Único e determinístico, ex.: "wikipedia:pt:12345:0003". */
  chunk_id: string;
  /** Id do artigo na fonte. */
  document_id: string;
  document_title: string;
  /** null = introdução. */
  section: string | null;
  text: string;
  language: string;
  /** "wikipedia" (ou "test"). */
  source: string;
  /** Snapshot, ex.: "20231101". */
  dataset_version: string;
  url: string;
}

export interface ChunkWithVector extends ChunkMetadata {
  vector: number[];
}

export interface SearchResult extends ChunkMetadata {
  /** Similaridade de cosseno (maior = mais parecido), já convertida de `_distance`. */
  score: number;
}

export interface SearchFilter {
  source?: string;
  language?: string;
}

export interface DeleteFilter {
  source: string;
  language?: string;
  dataset_version?: string;
}

export interface VectorStoreInfo {
  rows: number;
  sizeOnDiskBytes: number;
  embeddingModel: string;
  dimensions: number;
  /** Há índice ANN no vetor (só acima do limiar de linhas). */
  indexed: boolean;
  /** Versão do LanceDB em uso (difere no Mac Intel). */
  engine: string;
}

export interface VectorSearchResponse {
  results: SearchResult[];
  embedMs: number;
  searchMs: number;
}
