import type { CatalogModel } from "../../shared/models";

// Catálogo orientado a dados: adicionar um modelo = adicionar uma entrada.
// `sizeBytes`/`sha256` vêm de `https://huggingface.co/api/models/<repo>/tree/main` (campos `lfs.size`/`lfs.oid`).
// `contextWindow`: Qwen e Phi do config.json do repositório original; Llama dos metadados GGUF
// (`llama.context_length`), pois o repositório da Meta é gated.

const GiB = 1024 ** 3;

/** Aproximação inicial: tamanho do arquivo × 2, arredondado para cima em GiB (revalidar na Semana 12). */
function ramFor(sizeBytes: number): number {
  return Math.ceil((sizeBytes * 2) / GiB) * GiB;
}

function entry(model: Omit<CatalogModel, "recommendedRamBytes" | "quantization">): CatalogModel {
  return { ...model, quantization: "Q4_K_M", recommendedRamBytes: ramFor(model.sizeBytes) };
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Qwen Research License: só uso NÃO comercial (pesquisa/avaliação); redistribuir exige cópia da licença + aviso "Notice".
  entry({
    id: "qwen2.5-3b-instruct-q4_k_m",
    name: "Qwen2.5 3B Instruct",
    developer: "Alibaba Qwen",
    license: "qwen-research",
    licenseSummary: "Somente uso não comercial; redistribuição permitida com cópia da licença e aviso de atribuição.",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE",
    downloadUrl:
      "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    sizeBytes: 1_929_903_264,
    sha256: "9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94",
    contextWindow: 32_768,
    languages: ["pt", "en", "es", "fr", "de", "it", "ru", "zh", "ja", "ko", "vi", "th", "ar"],
  }),
  // Llama 3.2 Community License: uso comercial permitido (< 700 mi MAU); redistribuir exige a licença, "Built with Llama" e aviso.
  entry({
    id: "llama-3.2-3b-instruct-q4_k_m",
    name: "Llama 3.2 3B Instruct",
    developer: "Meta",
    license: "llama3.2",
    licenseSummary:
      "Uso comercial permitido (exceto > 700 mi usuários/mês); redistribuição exige a licença, \"Built with Llama\" e aviso de atribuição.",
    licenseUrl: "https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/main/LICENSE.txt",
    downloadUrl:
      "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sizeBytes: 2_019_377_696,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
    contextWindow: 131_072,
    languages: ["pt", "en", "es", "fr", "de", "it", "hi", "th"],
  }),
  // MIT: uso comercial e redistribuição livres, mantendo o aviso de copyright e a licença.
  entry({
    id: "phi-3.5-mini-instruct-q4_k_m",
    name: "Phi-3.5 mini Instruct",
    developer: "Microsoft",
    license: "mit",
    licenseSummary: "Uso comercial e redistribuição livres, mantendo o aviso de copyright e a licença MIT.",
    licenseUrl: "https://huggingface.co/microsoft/Phi-3.5-mini-instruct/blob/main/LICENSE",
    downloadUrl:
      "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
    sizeBytes: 2_393_232_672,
    sha256: "e4165e3a71af97f1b4820da61079826d8752a2088e313af0c7d346796c38eff5",
    contextWindow: 131_072,
    languages: [
      "pt", "en", "es", "fr", "de", "it", "nl", "pl", "ru", "uk", "cs", "da",
      "fi", "no", "sv", "hu", "tr", "he", "ar", "zh", "ja", "ko", "th",
    ],
  }),
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}
