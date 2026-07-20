/**
 * Layout for the shop's informational pages (/about, /how-to-order, /terms,
 * /privacy, /refund). All five are the same shape — a title, a lead paragraph,
 * then N heading+body blocks — so they share one component rather than five
 * near-identical files.
 *
 * The copy lives in packages/core/locales/{en,id}.json under a per-page
 * prefix: `web.<prefix>_title`, `_intro`, and `_h1.._hN` / `_p1.._pN`. Nothing
 * here is fetched: these pages state policy, not data.
 *
 * Whatever is rendered here must match the crawler shell built for the same
 * path in apps/storefront/src/routes/spaShell.ts — the two are read as one
 * page, and serving them different text is cloaking.
 */
import { Link } from "react-router-dom";
import { LifeBuoy } from "lucide-react";
import { t } from "../../lib/i18n";

export interface StaticPageProps {
  /** Locale key prefix, e.g. "about" → `web.about_title`. */
  prefix: string;
  /** How many `_hN`/`_pN` blocks this page has. */
  blocks: number;
  /** Substituted into `_intro` and every `_pN` (e.g. `{ shop }`). */
  args?: Record<string, unknown>;
  /** Page-specific blocks appended after the numbered ones (see PrivacyPage). */
  children?: React.ReactNode;
}

export default function StaticPage({ prefix, blocks, args = {}, children }: StaticPageProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-ink sm:text-4xl">{t(`web.${prefix}_title`)}</h1>
      <p className="mt-3 text-lg text-ink-soft">{t(`web.${prefix}_intro`, args)}</p>

      <article className="mt-10 space-y-8">
        {Array.from({ length: blocks }, (_, i) => i + 1).map((n) => (
          <section key={n}>
            <h2 className="font-display text-xl font-bold text-ink">{t(`web.${prefix}_h${n}`)}</h2>
            <p className="mt-2 leading-relaxed text-ink-soft">{t(`web.${prefix}_p${n}`, args)}</p>
          </section>
        ))}
        {children}
      </article>

      {/* Never strand the reader on a policy page — every one of them ends on
          the same forward action the policies themselves point at. */}
      <div className="mt-12 rounded-2xl border border-line bg-card p-6 shadow-xs">
        <h2 className="font-display text-lg font-bold text-ink">{t("web.static_help_title")}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t("web.static_help_body")}</p>
        <Link
          to="/account/support"
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-pine px-4 py-2.5 font-semibold text-white shadow-soft transition-colors hover:bg-pine-dark"
        >
          <LifeBuoy className="h-4 w-4" />
          {t("web.static_help_cta")}
        </Link>
      </div>
    </div>
  );
}
