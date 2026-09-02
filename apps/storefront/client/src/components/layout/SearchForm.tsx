/**
 * Persistent storefront search field — a pill input that routes to /search on
 * submit. Extracted verbatim from the old single-file Layout.tsx (Task 5 chrome
 * split); used by Navbar (desktop bar + mobile secondary row).
 */
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { t } from "../../lib/i18n";

export function SearchForm({ inputAriaLabel }: { inputAriaLabel: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("q");
    navigate(`/search?q=${encodeURIComponent(typeof value === "string" ? value : "")}`);
  }

  return (
    <form onSubmit={onSubmit} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        name="q"
        key={q}
        defaultValue={q}
        placeholder={t("web.search_placeholder")}
        className="h-10 w-full rounded-full border border-line bg-paper pl-9 pr-4 text-sm focus:border-pine focus:bg-card focus:outline-none focus:ring-2 focus:ring-pine-tint"
        aria-label={inputAriaLabel}
      />
    </form>
  );
}

export default SearchForm;
