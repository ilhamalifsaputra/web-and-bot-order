import { cn } from "@/lib/utils";

type ProgressBarTone = "grass" | "amberx" | "rust";

interface ProgressBarProps {
  value: number;
  tone: ProgressBarTone;
  className?: string;
}

const TONE_CLASS: Record<ProgressBarTone, string> = {
  grass: "bg-grass",
  amberx: "bg-amberx",
  rust: "bg-rust",
};

export function ProgressBar({ value, tone, className }: ProgressBarProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-sand", className)}>
      <div
        className={cn("h-full rounded-full transition-all", TONE_CLASS[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
