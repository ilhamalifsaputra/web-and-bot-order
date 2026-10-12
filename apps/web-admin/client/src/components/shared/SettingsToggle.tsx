import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface SettingsToggleProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  pending?: boolean;
  disabledReason?: string;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}

export function SettingsToggle({ id, label, description, checked, disabled, pending, disabledReason, onCheckedChange, className }: SettingsToggleProps) {
  const help = disabledReason || description;
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-4 py-2", className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-ink">{label}</label>
        {help && <p id={`${id}-description`} className="mt-1 text-xs text-ink-soft">{help}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span aria-hidden="true" className="text-xs font-medium text-ink-soft">{checked ? "ON" : "OFF"}</span>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled || pending} aria-busy={pending || undefined} aria-describedby={help ? `${id}-description` : undefined} />
        {pending && <span role="status" className="text-xs text-ink-soft">Saving…</span>}
      </div>
    </div>
  );
}
