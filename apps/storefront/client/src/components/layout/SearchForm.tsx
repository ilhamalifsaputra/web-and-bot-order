/**
 * Persistent storefront search trigger — the pill in the desktop header. It no
 * longer navigates to a `/search` page (that page is gone, Task 12): search is
 * now the `SearchOverlay`, and this pill just opens it. Kept as its own
 * component (and file name) so Navbar's structure is untouched.
 */
import { Search } from "lucide-react";
import { t } from "../../lib/i18n";
import { useSearchOverlay } from "../shop/SearchOverlay";

export function SearchForm({ inputAriaLabel }: { inputAriaLabel: string }) {
  const { open } = useSearchOverlay();

  return (
    <button
      type="button"
      onClick={() => open()}
      aria-label={inputAriaLabel}
      aria-haspopup="dialog"
      className="flex h-10 w-full items-center gap-2 rounded-full border border-line bg-paper pl-3 pr-4 text-left text-sm text-ink-faint transition-colors hover:border-pine hover:bg-card focus:border-pine focus:bg-card focus:outline-none focus:ring-2 focus:ring-pine-tint"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("web.search_placeholder")}</span>
    </button>
  );
}

export default SearchForm;
