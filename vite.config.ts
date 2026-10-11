import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

// Pacotes nativos/ESM-only que o Main carrega de node_modules (nunca empacotados pelo Rollup).
const externals = ["node-llama-cpp", "better-sqlite3", "@huggingface/transformers", "onnxruntime-node", "sharp", "@lancedb/lancedb", "lancedb-intel", "apache-arrow"];

// CSP do app empacotado: só recursos do próprio app; nada inline em script, nada remoto
// (o app é offline e o conteúdo do LLM é não confiável). Em dev o Vite precisa de script inline e
// websocket de HMR, então a CSP só é aplicada no build.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "w4e-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig({
  plugins: [
    react(),
    contentSecurityPolicy(),
    electron({
      main: {
        // `worker` = processo de ingestão (utilityProcess), com os mesmos pacotes nativos externos.
        entry: { main: "electron/main.ts", worker: "electron/ingestion/worker.ts" },
        vite: { build: { rollupOptions: { external: externals } } },
      },
      preload: {
        input: "electron/preload.ts",
        // Preload em CommonJS (.cjs) para manter sandbox: true.
        vite: {
          build: {
            rollupOptions: {
              output: { format: "cjs", entryFileNames: "preload.cjs", codeSplitting: false },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
});
