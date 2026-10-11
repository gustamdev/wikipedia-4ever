// Teste do DownloadManager contra um servidor HTTP local com suporte a Range.
// Rodar: npm test   (node --test; Node ≥ 22.18 executa TypeScript nativamente)
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { DownloadProgress, DownloadState } from "../../shared/models";
import { DownloadManager, partPathOf, type DownloadRequest } from "./download-manager.ts";

const SIZE = 3 * 1024 * 1024 + 123;
const CHUNK = 64 * 1024;
const BODY = randomBytes(SIZE);
const SHA256 = createHash("sha256").update(BODY).digest("hex");

interface Hit {
  path: string;
  range?: string;
  status: number;
}

let server: http.Server;
let baseUrl: string;
let tmp: string;
const hits: Hit[] = [];

/** Envia `data` em pedaços de 64 KB, com `delayMs` entre eles (para dar tempo de pausar). */
function sendSlowly(res: http.ServerResponse, data: Buffer, delayMs: number, dropAfter?: number) {
  let offset = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (dropAfter !== undefined && offset >= dropAfter) {
      res.socket?.destroy(); // simula queda de rede
      return;
    }
    if (offset >= data.length) {
      res.end();
      return;
    }
    const chunk = data.subarray(offset, offset + CHUNK);
    offset += chunk.length;
    res.write(chunk);
    setTimeout(tick, delayMs);
  };
  tick();
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "w4e dl ção-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const delay = Number(url.searchParams.get("delay") ?? "0");
    const drop = url.searchParams.get("drop");
    const range = req.headers.range;
    const record = (status: number) => hits.push({ path: url.pathname, range, status });

    if (url.pathname === "/redirect") {
      record(302);
      res.writeHead(302, { Location: `/file${url.search}` });
      res.end();
      return;
    }
    if (url.pathname === "/error") {
      record(404);
      res.writeHead(404);
      res.end();
      return;
    }
    const honorRange = url.pathname === "/file";
    const match = honorRange && range ? /^bytes=(\d+)-$/.exec(range) : null;
    if (match) {
      const start = Number(match[1]);
      if (start >= SIZE) {
        record(416);
        res.writeHead(416, { "Content-Range": `bytes */${SIZE}` });
        res.end();
        return;
      }
      record(206);
      res.writeHead(206, {
        "Content-Length": SIZE - start,
        "Content-Range": `bytes ${start}-${SIZE - 1}/${SIZE}`,
        "Accept-Ranges": "bytes",
      });
      sendSlowly(res, BODY.subarray(start), delay); // `drop` só derruba a 1ª requisição (sem Range)
      return;
    }
    record(200);
    res.writeHead(200, { "Content-Length": SIZE, "Accept-Ranges": honorRange ? "bytes" : "none" });
    sendSlowly(res, BODY, delay, drop === null ? undefined : Number(drop));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
});

let counter = 0;
function request(query = "", overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  const id = `file-${++counter}`;
  return {
    id,
    url: `${baseUrl}/redirect${query}`,
    destPath: path.join(tmp, `${id}.gguf`),
    expectedSha256: SHA256,
    expectedSize: SIZE,
    ...overrides,
  };
}

function harness(concurrency = 1, progressIntervalMs = 20) {
  const events: Array<DownloadProgress & { at: number }> = [];
  const waiters: Array<{ match: (p: DownloadProgress) => boolean; resolve: (p: DownloadProgress) => void }> = [];
  const manager = new DownloadManager({
    concurrency,
    progressIntervalMs,
    onProgress: (p) => {
      events.push({ ...p, at: Date.now() });
      for (const w of [...waiters]) {
        if (w.match(p)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(p);
        }
      }
    },
  });
  const waitFor = (match: (p: DownloadProgress) => boolean, timeoutMs = 15_000) =>
    new Promise<DownloadProgress>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout esperando evento")), timeoutMs);
      waiters.push({
        match,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });
  const waitState = (id: string, state: DownloadState) => waitFor((p) => p.id === id && p.state === state);
  return { manager, events, waitFor, waitState };
}

async function sizeOf(file: string) {
  return (await stat(file)).size;
}

describe("DownloadManager", () => {
  test("download completo: segue redirect, verifica SHA-256 e renomeia", async () => {
    const { manager, events, waitState } = harness();
    const req = request();
    const done = waitState(req.id, "completed");
    manager.enqueue(req);
    await done;

    assert.ok(existsSync(req.destPath));
    assert.ok(!existsSync(partPathOf(req.destPath)));
    assert.deepEqual(await readFile(req.destPath), BODY);
    const states = new Set(events.filter((e) => e.id === req.id).map((e) => e.state));
    for (const s of ["queued", "downloading", "verifying", "completed"]) assert.ok(states.has(s as DownloadState), s);
    assert.equal(manager.get(req.id), undefined);
  });

  test("pausa mantém o .part e retomada usa Range a partir do tamanho dele", async () => {
    const { manager, waitFor, waitState } = harness();
    const req = request("?delay=5");
    manager.enqueue(req);
    await waitFor((p) => p.id === req.id && p.state === "downloading" && p.bytesDownloaded > 512 * 1024);

    const paused = waitState(req.id, "paused");
    manager.pause(req.id);
    const pausedEvent = await paused;
    const partSize = await sizeOf(partPathOf(req.destPath));
    assert.ok(partSize > 0 && partSize < SIZE, `tamanho do .part: ${partSize}`);
    assert.equal(pausedEvent.bytesDownloaded, partSize);
    assert.equal(pausedEvent.bytesPerSecond, 0);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await sizeOf(partPathOf(req.destPath)), partSize, ".part não cresce pausado");

    hits.length = 0;
    const done = waitState(req.id, "completed");
    manager.resume(req.id);
    const firstAfterResume = await waitFor((p) => p.id === req.id && p.state === "downloading");
    assert.ok(firstAfterResume.bytesDownloaded >= partSize, "não recomeçou do zero");
    await done;

    const fileHit = hits.find((h) => h.path === "/file");
    assert.equal(fileHit?.range, `bytes=${partSize}-`, "Range reenviado após o redirect");
    assert.equal(fileHit?.status, 206);
    assert.deepEqual(await readFile(req.destPath), BODY);
  });

  test("cancelar apaga o .part", async () => {
    const { manager, waitFor } = harness();
    const req = request("?delay=5");
    manager.enqueue(req);
    await waitFor((p) => p.id === req.id && p.bytesDownloaded > 256 * 1024);
    await manager.cancel(req.id);
    assert.ok(!existsSync(partPathOf(req.destPath)));
    assert.ok(!existsSync(req.destPath));
    assert.equal(manager.get(req.id), undefined);
  });

  test("SHA-256 divergente → error e arquivo apagado", async () => {
    const { manager, waitState } = harness();
    const req = request("", { expectedSha256: "0".repeat(64) });
    manager.enqueue(req);
    const failed = await waitState(req.id, "error");
    assert.match(failed.error ?? "", /SHA-256 não confere/);
    assert.ok(!existsSync(partPathOf(req.destPath)));
    assert.ok(!existsSync(req.destPath));
  });

  test(".part corrompido (1 byte alterado) → error na verificação", async () => {
    const { manager, waitFor, waitState } = harness();
    const req = request("?delay=5");
    manager.enqueue(req);
    await waitFor((p) => p.id === req.id && p.bytesDownloaded > 256 * 1024);
    const paused = waitState(req.id, "paused");
    manager.pause(req.id);
    await paused;

    const part = partPathOf(req.destPath);
    const data = await readFile(part);
    data[100] ^= 0xff;
    await writeFile(part, data);

    const failed = waitState(req.id, "error");
    manager.resume(req.id);
    assert.match((await failed).error ?? "", /SHA-256 não confere/);
    assert.ok(!existsSync(part));
  });

  test("fila FIFO: com limite 1, o segundo fica queued até o primeiro terminar", async () => {
    const { manager, events, waitState } = harness(1);
    const a = request("?delay=1");
    const b = request();
    const aDone = waitState(a.id, "completed");
    const bDone = waitState(b.id, "completed");
    manager.enqueue(a);
    manager.enqueue(b);
    assert.equal(manager.get(b.id)?.state, "queued");
    await aDone;
    await bDone;
    const firstBDownloading = events.findIndex((e) => e.id === b.id && e.state === "downloading");
    const aCompleted = events.findIndex((e) => e.id === a.id && e.state === "completed");
    assert.ok(aCompleted < firstBDownloading, "b só começa depois de a terminar");
  });

  test("servidor que ignora Range (200) → recomeça do zero sem corromper", async () => {
    const { manager, waitState } = harness();
    const req = request("", { url: `${baseUrl}/norange` });
    await writeFile(partPathOf(req.destPath), BODY.subarray(0, 1000));
    await manager.restore(req);
    const done = waitState(req.id, "completed");
    manager.resume(req.id);
    await done;
    assert.deepEqual(await readFile(req.destPath), BODY);
  });

  test("queda de rede → paused com erro; retomar conclui", async () => {
    const { manager, waitState } = harness();
    const req = request(`?drop=${1024 * 1024}`);
    manager.enqueue(req);
    const paused = await waitState(req.id, "paused");
    assert.match(paused.error ?? "", /Conexão interrompida/);
    const partSize = await sizeOf(partPathOf(req.destPath));
    assert.ok(partSize > 0 && partSize < SIZE);

    const done = waitState(req.id, "completed");
    manager.resume(req.id);
    await done;
    assert.deepEqual(await readFile(req.destPath), BODY);
  });

  test("restore: .part de uma execução anterior aparece como paused", async () => {
    const { manager } = harness();
    const req = request();
    await writeFile(partPathOf(req.destPath), BODY.subarray(0, 4096));
    assert.equal(await manager.restore(req), true);
    assert.equal(manager.get(req.id)?.state, "paused");
    assert.equal(manager.get(req.id)?.bytesDownloaded, 4096);
    assert.equal(await manager.restore(request()), false);
  });

  test("HTTP 404 → error (não recuperável)", async () => {
    const { manager, waitState } = harness();
    const req = request("", { url: `${baseUrl}/error` });
    manager.enqueue(req);
    assert.match((await waitState(req.id, "error")).error ?? "", /HTTP 404/);
  });

  test("throttle default: no máximo 1 evento a cada 50 ms (fora mudanças de estado)", async () => {
    const { manager, events, waitState } = harness(1, 200);
    const req = request("?delay=5");
    const done = waitState(req.id, "completed");
    manager.enqueue(req);
    await done;
    const ticks = events.filter((e) => e.state === "downloading" || e.state === "verifying");
    const gaps = ticks.slice(1).map((e, i) => (e.state === ticks[i].state ? e.at - ticks[i].at : Infinity));
    assert.ok(ticks.length >= 3, `eventos: ${ticks.length}`);
    assert.ok(Math.min(...gaps) >= 49, `menor intervalo: ${Math.min(...gaps)} ms`);
  });

  test("espaço insuficiente → error sem começar", async () => {
    const { manager, waitState } = harness();
    const req = request("", { expectedSize: Number.MAX_SAFE_INTEGER });
    hits.length = 0;
    manager.enqueue(req);
    assert.match((await waitState(req.id, "error")).error ?? "", /Espaço insuficiente/);
    assert.equal(hits.length, 0, "nenhuma requisição HTTP feita");
  });
});
