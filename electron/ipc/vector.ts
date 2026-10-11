import { ipcMain } from "electron";
import type { VectorSearchResponse } from "../../shared/chunk";
import { IPC } from "../../shared/ipc-channels";
import type { EmbeddingEngine } from "../embeddings/embedding-engine";
import { testChunks } from "../vector/test-fixtures";
import type { VectorStore } from "../vector/vector-store";

const MAX_QUERY_CHARS = 2000;
const MAX_TOP_K = 50;

/**
 * `writeLocked`: há uma ingestão em andamento. Só o worker dela escreve no banco nesse período;
 * as escritas de dev são recusadas (a busca continua liberada).
 */
export function registerVectorHandlers(store: VectorStore, embeddings: EmbeddingEngine, writeLocked: () => boolean): void {
  const assertWritable = () => {
    if (writeLocked()) throw new Error("A base está sendo indexada; tente de novo quando a indexação terminar ou for cancelada.");
  };

  ipcMain.handle(IPC.vectorLoadTestData, async () => {
    assertWritable();
    const chunks = testChunks();
    const started = Date.now();
    const vectors = await embeddings.embed(chunks.map((c) => c.text), "passage");
    await store.insertChunks(chunks.map(({ topic: _topic, ...chunk }, i) => ({ ...chunk, vector: vectors[i] })));
    console.info(`[vector] ${chunks.length} chunks de teste inseridos em ${Date.now() - started} ms`);
    return { inserted: chunks.length };
  });

  ipcMain.handle(IPC.vectorClearTestData, () => {
    assertWritable();
    return store.deleteBy({ source: "test" });
  });

  ipcMain.handle(IPC.vectorSearch, async (_event, payload: unknown): Promise<VectorSearchResponse> => {
    const p = payload as { query?: unknown; topK?: unknown } | null;
    if (typeof p?.query !== "string" || !p.query.trim() || p.query.length > MAX_QUERY_CHARS) {
      throw new Error("Pergunta vazia ou longa demais.");
    }
    const topK = p.topK;
    if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      throw new Error(`topK deve ser um inteiro entre 1 e ${MAX_TOP_K}.`);
    }
    const t0 = performance.now();
    const [vector] = await embeddings.embed([p.query], "query");
    const t1 = performance.now();
    const results = await store.search(vector, topK);
    const t2 = performance.now();
    return { results, embedMs: Math.round(t1 - t0), searchMs: Math.round(t2 - t1) };
  });

  ipcMain.handle(IPC.vectorInfo, () => store.getInfo());
}
