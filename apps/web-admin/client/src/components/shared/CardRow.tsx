import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CardRowProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

export function CardRow({ label, value, className }: CardRowProps): JSX.Element {
  return (
    <div className={cn("flex items-center justify-between py-2", className)}>
      <span className="text-sm text-ink-soft">{label}</span>
      <div className="text-sm text-ink">{value}</div>
    </div>
  );
}
