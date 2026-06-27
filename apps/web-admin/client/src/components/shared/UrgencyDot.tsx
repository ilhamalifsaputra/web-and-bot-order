const COLOR: Record<"ok" | "warn" | "critical" | "idle", string> = {
  ok: "bg-grass",
  warn: "bg-amberx",
  critical: "bg-rust",
  idle: "bg-ink-faint",
};

export function UrgencyDot({ level }: { level: "ok" | "warn" | "critical" | "idle" }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${COLOR[level]}`} aria-hidden="true" />;
}
