import type { ReactNode } from "react";

export function Chip({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return <span className={`chip ${className}`.trim()}>{children}</span>;
}
