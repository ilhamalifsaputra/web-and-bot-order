import { Search } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Optional callback triggered when the user presses Enter while focused in the input. */
  onSearch?: () => void;
  placeholder?: string;
  className?: string;
  /** Swaps the leading Search icon for a spinning Spinner — for callers that
   * commit this field live (e.g. a debounced search) and want to show a
   * background refetch in flight. Reuses the app's existing inline-spinner
   * convention (08_UX_RULES.md §1); omit for the default Apply-button flow. */
  loading?: boolean;
}

export function SearchBar({ value, onChange, onSearch, placeholder, className, loading }: SearchBarProps): React.JSX.Element {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      {loading ? (
        <>
          <Spinner className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <span role="status" className="sr-only">Searching…</span>
        </>
      ) : (
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      )}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onSearch) {
            e.preventDefault();
            onSearch();
          }
        }}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  );
}
