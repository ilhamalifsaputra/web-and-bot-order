/**
 * SearchOverlay — the storefront's product search, as an overlay panel instead
 * of a route (page-templates.md §10, user decision #2). It replaces the old
 * full `pages/SearchPage.tsx`.
 *
 * Shape:
 *   - desktop (sm+): a panel dropping under the header, anchored below the
 *     persistent search pill, over a light scrim;
 *   - mobile: full-screen, over a solid scrim.
 *
 * A11y — a `role="dialog"` + `aria-modal` shell (the proven `useDialogA11y`
 * contract: body-scroll lock, Esc-to-close, focus trap, focus restore to the
 * trigger) wrapping an APG combobox: the text field is `role="combobox"` with
 * `aria-expanded` / `aria-controls` / `aria-activedescendant` pointing at a
 * `role="listbox"` of `role="option"` result rows; ArrowUp/ArrowDown move the
 * active option, Enter opens it. `prefers-reduced-motion` rides on the app-wide
 * `<MotionConfig reducedMotion="user">` (main.tsx), same as MobileDrawer/Modal.
 *
 * Live results debounce (220ms) the EXISTING `GET /api/v1/pages/search?q=`
 * endpoint — no `?sort=`, no shareable results page (both dropped with the
 * route; logged in docs/archive/implementation/deviations.md §12-search-overlay).
 *
 * `SearchOverlayProvider` owns the open/close state and is mounted once in
 * `Layout.tsx`, above the routed page, so the overlay can float over any route
 * AND be opened by the `/search` → `/` redirect (`pages/SearchRedirect.tsx`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Package, Search, X } from "lucide-react";
import { apiGet } from "../../api/client";
import type { SearchPageData } from "../../api/types";
import type { ProductCardData } from "./ProductCard";
import { t } from "../../lib/i18n";
import { fadeIn, scrim } from "../../lib/motion";
import { clearRecent, pushRecent, readRecent } from "../../lib/recentSearches";
import { useDialogA11y } from "../ui/useDialogA11y";
import Price from "./Price";

/** ~220ms: long enough to skip the per-keystroke fetch on a fast typist, short
 * enough that results feel live. */
const DEBOUNCE_MS = 220;
const SKELETON_ROWS = [0, 1, 2, 3, 4];

interface SearchOverlayValue {
  isOpen: boolean;
  /** Open the panel, optionally pre-filling (and immediately running) a query. */
  open: (initialQuery?: string) => void;
  close: () => void;
}

const SearchOverlayContext = createContext<SearchOverlayValue | null>(null);

export function useSearchOverlay(): SearchOverlayValue {
  const value = useContext(SearchOverlayContext);
  if (!value) {
    throw new Error("useSearchOverlay must be used within <SearchOverlayProvider>");
  }
  return value;
}

export function SearchOverlayProvider({
  fx,
  children,
}: {
  fx: string | number | null | undefined;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");

  const open = useCallback((query = "") => {
    setInitialQuery(query);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <SearchOverlayContext.Provider value={value}>
      {children}
      <SearchOverlay open={isOpen} initialQuery={initialQuery} onClose={close} fx={fx} />
    </SearchOverlayContext.Provider>
  );
}

function ResultThumb({ product }: { product: ProductCardData }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sand">
      {product.image ? (
        <img src={product.image} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <Package className="h-5 w-5 text-ink-faint" aria-hidden="true" />
      )}
    </span>
  );
}

function SearchOverlay({
  open,
  initialQuery,
  onClose,
  fx,
}: {
  open: boolean;
  initialQuery: string;
  onClose: () => void;
  fx: string | number | null | undefined;
}) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const [value, setValue] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [recent, setRecent] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Dialog a11y contract: scroll-lock, Esc→onClose, focus trap, focus restore
  // to whatever opened the panel (the header pill or the mobile search icon).
  useDialogA11y({ open, onClose, panelRef });

  // Re-seed on every open so a `/search?q=x` deep link (or reopening the pill)
  // starts from the right query and a fresh copy of the history.
  useEffect(() => {
    if (!open) return;
    setValue(initialQuery);
    setDebounced(initialQuery.trim());
    setActiveIndex(-1);
    setRecent(readRecent());
  }, [open, initialQuery]);

  // Debounce the field into the query key.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [value]);

  const enabled = open && debounced.length > 0;
  const { data, isFetching } = useQuery({
    queryKey: ["search-overlay", debounced],
    queryFn: () => apiGet<SearchPageData>(`/api/v1/pages/search?q=${encodeURIComponent(debounced)}`),
    enabled,
  });

  const results = enabled && data ? data.products : [];
  const showSkeleton = enabled && isFetching && !data;
  const showEmpty = enabled && !isFetching && data != null && data.products.length === 0;
  const showResults = enabled && results.length > 0;

  // A stale active index (results shrank, or the query changed) must never point
  // past the end — reset it whenever the result set identity changes.
  useEffect(() => {
    setActiveIndex(-1);
  }, [data]);

  const optionId = (index: number) => `${listboxId}-opt-${index}`;
  const activeDescendant =
    showResults && activeIndex >= 0 && activeIndex < results.length
      ? optionId(activeIndex)
      : undefined;

  // Keyboard selection can walk a highlighted row past the visible window of
  // the `overflow-y-auto` results container (it can be taller than
  // `sm:max-h-[70vh]`); pull the active option back into view on every move.
  // Skip when nothing is highlighted (`activeIndex < 0`).
  useEffect(() => {
    if (activeIndex < 0) return;
    const row = document.getElementById(`${listboxId}-opt-${activeIndex}`);
    // Optional call: jsdom (test env) has no `scrollIntoView` implementation.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId]);

  const selectResult = useCallback(
    (product: ProductCardData) => {
      if (value.trim()) setRecent(pushRecent(value));
      onClose();
      navigate(`/p/${product.slug}`);
    },
    [value, onClose, navigate],
  );

  const runRecent = useCallback((term: string) => {
    setValue(term);
    setDebounced(term.trim());
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeIndex >= 0 && results[activeIndex]) {
      selectResult(results[activeIndex]!);
      return;
    }
    // No highlighted row: there is no dedicated results page to route to, so
    // stay open showing every match. Record the term (explicit intent) and
    // flush the debounce so the list is current.
    const term = value.trim();
    if (!term) return;
    setRecent(pushRecent(term));
    setDebounced(term);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showResults) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? -1 : i - 1));
    }
  }

  function onClearRecent() {
    clearRecent();
    setRecent([]);
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            aria-hidden="true"
            className="absolute inset-0 bg-ink/45 sm:bg-ink/25"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            variants={fadeIn}
            initial="initial"
            animate="animate"
            exit="exit"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t("web.nav_search")}
            className="absolute inset-0 z-10 flex flex-col bg-card outline-none sm:inset-auto sm:left-1/2 sm:top-20 sm:max-h-[70vh] sm:w-full sm:max-w-xl sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:border-line sm:shadow-lift"
          >
            <form onSubmit={onSubmit} className="flex items-center gap-2 border-b border-line p-3">
              <Search className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={showResults}
                aria-controls={showResults ? listboxId : undefined}
                aria-activedescendant={activeDescendant}
                aria-autocomplete="list"
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("web.search_placeholder")}
                aria-label={t("web.search_placeholder")}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                type="button"
                onClick={onClose}
                aria-label={t("web.search_close")}
                className="shrink-0 rounded-lg p-1.5 text-ink-soft transition-colors hover:bg-sand hover:text-ink"
              >
                <X className="h-5 w-5" />
              </button>
            </form>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {showSkeleton && (
                <div aria-busy="true" aria-label={t("web.loading")} className="space-y-1">
                  {SKELETON_ROWS.map((i) => (
                    <div key={i} className="flex items-center gap-3 p-2">
                      <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-sand" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3.5 w-2/3 animate-pulse rounded bg-sand" />
                        <div className="h-3 w-1/3 animate-pulse rounded bg-sand" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showEmpty && (
                <p className="px-2 py-6 text-center text-sm text-ink-soft">
                  {t("web.search_no_results", { q: debounced })}{" "}
                  <Link to="/products" onClick={onClose} className="font-medium text-pine hover:underline">
                    {t("web.search_browse_all")}
                  </Link>
                </p>
              )}

              {showResults && (
                <ul id={listboxId} role="listbox" aria-label={t("web.nav_search")}>
                  {results.map((product, index) => (
                    <li
                      key={product.slug}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === activeIndex}
                      onClick={() => selectResult(product)}
                      onMouseMove={() => setActiveIndex(index)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl p-2 ${
                        index === activeIndex ? "bg-sand" : ""
                      }`}
                    >
                      <ResultThumb product={product} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          {product.name}
                        </span>
                        <span className="block truncate text-xs text-ink-faint">
                          {product.category_name}
                        </span>
                      </span>
                      <Price value={product.from_price} fx={fx} />
                    </li>
                  ))}
                </ul>
              )}

              {!enabled && (
                <div className="p-2">
                  {recent.length > 0 ? (
                    <section aria-label={t("web.recent_searches")}>
                      <div className="flex items-center justify-between gap-3 px-2 pb-1">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          {t("web.recent_searches")}
                        </h2>
                        <button
                          type="button"
                          onClick={onClearRecent}
                          className="text-xs font-medium text-pine hover:underline"
                        >
                          {t("web.clear_recent")}
                        </button>
                      </div>
                      <ul>
                        {recent.map((term) => (
                          <li key={term}>
                            <button
                              type="button"
                              onClick={() => runRecent(term)}
                              className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-sand"
                            >
                              <Search
                                className="h-4 w-4 shrink-0 text-ink-faint"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                                {term}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : (
                    <p className="px-2 py-6 text-center text-sm text-ink-faint">
                      {t("web.search_placeholder")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default SearchOverlay;
