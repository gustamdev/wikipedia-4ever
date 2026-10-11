import type { ReactNode } from "react";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function StatusTag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === "neutral" ? "tag" : `tag tag--${tone}`}>{children}</span>;
}
