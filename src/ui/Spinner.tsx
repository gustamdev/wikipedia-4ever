export function Spinner({ label = "carregando" }: { label?: string }) {
  return (
    <span role="status" aria-label={label}>
      <span className="spinner" aria-hidden="true">▍</span>
    </span>
  );
}
