// Captura screenshot do Renderer de um Electron com --remote-debugging-port.
// Uso: node scripts/cdp-screenshot.mjs <porta> <arquivo.png> [largura altura] [light|dark]
import { writeFileSync } from "node:fs";

const [port = "9333", file = "screenshot.png", width = "1200", height = "800", theme = "light"] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === "page");
if (!page) throw new Error("Nenhuma página encontrada.");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  pending.get(data.id)?.(data);
};
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await call("Emulation.setDeviceMetricsOverride", { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
await call("Runtime.evaluate", { expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}` });
await new Promise((r) => setTimeout(r, 200));
const shot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(file, Buffer.from(shot.result.data, "base64"));
await call("Emulation.clearDeviceMetricsOverride");
ws.close();
console.log(`ok ${file} (${width}x${height}, ${theme})`);
