import type { HTMLAttributes } from "react";

export function Panel({ surface = false, className, ...rest }: HTMLAttributes<HTMLDivElement> & { surface?: boolean }) {
  return <div className={["panel", surface && "panel--surface", className].filter(Boolean).join(" ")} {...rest} />;
}
