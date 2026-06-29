import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShoppingCart, Package, Users } from "lucide-react";
import { apiGet } from "../../api/client";

interface SearchResult {
  type: "order" | "product" | "user";
  id: string | number;
  label: string;
  sublabel?: string;
  href: string;
}

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
}

const TYPE_ICONS = {
  order: ShoppingCart,
  product: Package,
  user: Users,
} as const;

const TYPE_LABELS: Record<SearchResult["type"], string> = {
  order: "Orders",
  product: "Products",
  user: "Users",
};

export function SearchModal({ open, onClose }: SearchModalProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      let cancelled = false;
      apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(query.trim())}`)
        .then(data => { if (!cancelled) setResults(Array.isArray(data) ? data : []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return <></>;

  const grouped = (["order", "product", "user"] as const)
    .map((type) => ({ type, items: results.filter((r) => r.type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-line bg-card shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <svg
            className="h-4 w-4 flex-shrink-0 text-ink-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <circle cx={11} cy={11} r={8} />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search orders, products, users..."
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {loading && <span className="text-xs text-ink-faint">Searching…</span>}
        </div>

        {/* Results */}
        {grouped.length > 0 && (
          <div className="max-h-80 overflow-y-auto py-2">
            {grouped.map(({ type, items }) => {
              const Icon = TYPE_ICONS[type];
              return (
                <div key={type}>
                  <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                    {TYPE_LABELS[type]}
                  </div>
                  {items.map((result) => (
                    <button
                      key={`${result.type}-${result.id}`}
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-sand"
                      onClick={() => {
                        navigate(result.href);
                        onClose();
                      }}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0 text-ink-faint" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">
                          {result.label}
                        </div>
                        {result.sublabel && (
                          <div className="truncate text-xs text-ink-soft">
                            {result.sublabel}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {query.trim() && !loading && grouped.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-ink-faint">
            No results for &ldquo;{query}&rdquo;
          </div>
        )}

        {/* Prompt when empty query */}
        {!query.trim() && (
          <div className="px-4 py-3 text-xs text-ink-faint">
            Type to search across orders, products, and customers.
          </div>
        )}
      </div>
    </div>
  );
}
