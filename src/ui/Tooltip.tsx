import type { ReactNode } from "react";

/** `align="end"` ancora o balão pela direita (para elementos encostados na borda direita). */
export function Tooltip({ text, align = "start", children }: { text: string; align?: "start" | "end"; children: ReactNode }) {
  return (
    <span className={align === "end" ? "tip tip--end" : "tip"} data-tip={text} tabIndex={0} aria-label={text}>
      {children}
    </span>
  );
}
