import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  block?: boolean;
}

export function Button({ variant = "default", block = false, className, type = "button", ...rest }: ButtonProps) {
  const classes = ["btn", variant !== "default" && `btn--${variant}`, block && "btn--block", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
