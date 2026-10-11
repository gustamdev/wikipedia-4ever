import type { ReactNode } from "react";

interface StateProps {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: StateProps) {
  return (
    <div className="state">
      <div className="state__title">{title}</div>
      {hint && <div className="state__hint">{hint}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ title, hint, action }: StateProps) {
  return (
    <div className="state state--error" role="alert">
      <div className="state__title">✕ {title}</div>
      {hint && <div className="state__hint">{hint}</div>}
      {action}
    </div>
  );
}
