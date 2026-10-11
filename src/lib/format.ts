const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const oneDecimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Bytes em GB/MB decimais (mesma unidade que o Hugging Face exibe). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${decimal.format(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${oneDecimal.format(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "calculando…";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** RAM em GB binários arredondados (como o sistema operacional exibe: 16 GB, não 17,18 GB). */
export function formatRam(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}
