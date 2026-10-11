const WIDTH = 20;

/** Barra em texto, estilo terminal: [█████░░░░░] 52% */
export function ProgressBar({ value }: { value: number }) {
  const clamped = Math.min(1, Math.max(0, value));
  const filled = Math.round(clamped * WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(WIDTH - filled);
  return (
    <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)}>
      [{bar}] {Math.round(clamped * 100)}%
    </span>
  );
}
