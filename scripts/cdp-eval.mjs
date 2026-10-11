// Avalia uma expressão JS no Renderer de um Electron em execução com --remote-debugging-port.
// Uso: node scripts/cdp-eval.mjs <porta> "<expressão (pode usar await)>"
const [port = "9333", expression] = process.argv.slice(2);
if (!expression) {
  console.error('Uso: node scripts/cdp-eval.mjs <porta> "<expressão>"');
  process.exit(2);
}

const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === "page");
if (!page) throw new Error("Nenhuma página encontrada.");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const result = await new Promise((resolve, reject) => {
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id === 1) resolve(data);
  };
  ws.onerror = reject;
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true },
    }),
  );
});
ws.close();

if (result.result?.exceptionDetails) {
  console.error(JSON.stringify(result.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.result?.result?.value, null, 2));
