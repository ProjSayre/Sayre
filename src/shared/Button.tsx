import type { ButtonHTMLAttributes } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  small?: boolean;
}

export function Button({ variant = "primary", small = false, className = "", ...rest }: Props): JSX.Element {
  const cls = ["btn", `btn--${variant}`, small ? "btn--small" : "", className].filter(Boolean).join(" ");
  return <button className={cls} {...rest} />;
}
