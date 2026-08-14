import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CardRowProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

export function CardRow({ label, value, className }: CardRowProps): JSX.Element {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-2", className)}>
      <span className="text-sm text-ink-soft shrink-0">{label}</span>
      <div className="text-sm text-ink min-w-0 break-words text-right">{value}</div>
    </div>
  );
}
