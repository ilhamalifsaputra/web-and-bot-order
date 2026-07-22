/**
 * Thin fill bar for a determinate 0-100 progress value (ticket-attachment
 * upload progress) — same minimal shape as the admin dashboard's own
 * ProgressBar, in this app's own tokens (storefront has no equivalent
 * component today).
 */
export interface ProgressBarProps {
  value: number;
}

export default function ProgressBar({ value }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-sand"
    >
      <div className="h-full rounded-full bg-pine transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
