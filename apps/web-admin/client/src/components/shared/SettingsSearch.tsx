import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

interface SettingsSearchProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The Settings page's own instant filter (Settings refinement §1) — visually
 * close to `components/shared/SearchBar.tsx` but a separate component: it
 * filters settings sections/fields/gateways (a different, page-specific
 * target) rather than SearchBar's generic list-of-rows, and it ships
 * `highlightMatch` alongside it for the match-highlighting the brief asks
 * for, which SearchBar has no equivalent of. Purely a controlled input —
 * SettingsPage owns the actual filtering logic.
 */
export function SettingsSearch({ value, onChange }: SettingsSearchProps): React.JSX.Element {
  return (
    <div className="relative mb-3 w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings…"
        aria-label="Search settings"
        className="pl-8"
        // Defense in depth for the same bug FieldRow's autoComplete fix
        // addresses: this is the nearest preceding text input to every
        // secret field on the page, which is exactly what a browser's
        // native password manager looks for when it guesses a "username"
        // partner for a password-shaped field it wants to autofill.
        autoComplete="off"
      />
    </div>
  );
}
