// Estimativa de espaço e de volume antes de ingerir (spec §17). Função pura: o chamador fornece os
// arquivos do Hugging Face, o que já está no disco e o espaço livre.
import type { IngestionEstimate } from "../../shared/ingestion";
import { E5_DIMENSIONS } from "../embeddings/embedding-engine.ts";
import type { DatasetFile } from "./hf-datasets";

/**
 * Razões medidas na Semana 7 (arquivo inteiro de cada idioma, chunker padrão): artigos e chunks por
 * byte de Parquet. Idiomas não medidos usam a média dos dois: a estimativa é grosseira (escritas e
 * compressão diferem) e a UI a rotula assim.
 */
const MEASURED: Record<string, { articlesPerByte: number; chunksPerByte: number }> = {
  pt: { articlesPerByte: 185_374 / 202_884_385, chunksPerByte: 542_745 / 202_884_385 },
  simple: { articlesPerByte: 241_787 / 156_885_218, chunksPerByte: 480_934 / 156_885_218 },
};

/**
 * Bytes por chunk no LanceDB: vetor float32 + texto (~156 tokens ≈ 600 caracteres) + metadados
 * (ids, título, seção, url). Calibrado com a execução real da Semana 8 (ver relatório).
 */
export const BYTES_PER_CHUNK_ON_DISK = E5_DIMENSIONS * 4 + 800;
/** IVF-PQ: código PQ por vetor + partições. */
export const INDEX_BYTES_PER_CHUNK = 40;

export interface EstimateInput {
  language: string;
  snapshot: string;
  files: readonly DatasetFile[];
  /** Bytes de cada arquivo que já estão no disco (completos), por nome. */
  presentBytes: ReadonlyMap<string, number>;
  freeBytes: number;
}

export function estimateIngestion(input: EstimateInput): IngestionEstimate {
  const rawBytes = input.files.reduce((sum, f) => sum + f.size, 0);
  const alreadyDownloadedBytes = input.files.reduce((sum, f) => sum + Math.min(f.size, input.presentBytes.get(f.name) ?? 0), 0);
  const measured = MEASURED[input.language];
  const ratios = measured ?? {
    articlesPerByte: (MEASURED.pt.articlesPerByte + MEASURED.simple.articlesPerByte) / 2,
    chunksPerByte: (MEASURED.pt.chunksPerByte + MEASURED.simple.chunksPerByte) / 2,
  };
  const chunksApprox = Math.round(rawBytes * ratios.chunksPerByte);
  const estimatedVectorBytes = chunksApprox * BYTES_PER_CHUNK_ON_DISK;
  const estimatedIndexBytes = chunksApprox * INDEX_BYTES_PER_CHUNK;
  const totalBytes = rawBytes - alreadyDownloadedBytes + estimatedVectorBytes + estimatedIndexBytes;
  return {
    language: input.language,
    snapshot: input.snapshot,
    rawBytes,
    alreadyDownloadedBytes,
    articlesApprox: Math.round(rawBytes * ratios.articlesPerByte),
    chunksApprox,
    estimatedVectorBytes,
    estimatedIndexBytes,
    totalBytes,
    freeBytes: input.freeBytes,
    sufficient: input.freeBytes >= totalBytes,
    estimateBasis: measured ? "measured" : "rough",
  };
}
