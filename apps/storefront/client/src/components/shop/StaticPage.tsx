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
 *
 * Blocks render through the shared `StepTimeline` (numbered badge + icon +
 * connector) instead of a plain heading/paragraph loop. `steps` supplies the
 * per-block icon and is optional so an unconfigured caller still renders (a
 * generic icon, no callouts) rather than breaking.
 */
import { Link } from "react-router-dom";
import { FileText, LifeBuoy, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import Callout, { type CalloutVariant } from "./Callout";
import StepTimeline, { type StepItem } from "./StepTimeline";

export interface StaticPageStep {
  icon: LucideIcon;
  /** Wraps this block's existing paragraph in a Callout instead of plain text. */
  callout?: CalloutVariant;
  /** Which locale block (`_h{n}`/`_p{n}`) this step reads from — defaults to
   *  its 1-based position in `steps`. Only needed once a `render` step
   *  upstream has consumed more than one block (How-to-Order's merged
   *  QRIS/USDT step shifts every later block's number). */
  block?: number;
  /** Escape hatch: replaces the default heading+paragraph for this step
   *  entirely — the node is responsible for its own heading(s) and `t()`
   *  calls (How-to-Order's merged QRIS/USDT step). */
  render?: React.ReactNode;
}

export interface StaticPageProps {
  prefix: string;
  /** How many `_hN`/`_pN` blocks this page has. */
  blocks: number;
  /** Substituted into `_intro` and every `_pN` (e.g. `{ shop }`). */
  args?: Record<string, unknown>;
  /** Per-block icon/callout config, in visual order. Optional for backward
   *  compatibility; falls back to one generic icon per block. */
  steps?: StaticPageStep[];
  /** Page-specific block appended after the numbered ones (see PrivacyPage). */
  children?: React.ReactNode;
}

export default function StaticPage({ prefix, blocks, args = {}, steps, children }: StaticPageProps) {
  const config: StaticPageStep[] = steps ?? Array.from({ length: blocks }, (_, i) => ({ icon: FileText, block: i + 1 }));
  const items: StepItem[] = config.map((step, idx) => {
    if (step.render) {
      return { icon: step.icon, description: step.render };
    }
    const n = step.block ?? idx + 1;
    const body = t(`web.${prefix}_p${n}`, args);
    return {
      icon: step.icon,
      title: t(`web.${prefix}_h${n}`),
      description: step.callout ? (
        <Callout variant={step.callout}>{body}</Callout>
      ) : (
        <p className="leading-relaxed text-ink-soft">{body}</p>
      ),
    };
  });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-ink sm:text-4xl">{t(`web.${prefix}_title`)}</h1>
      <p className="mt-3 text-lg text-ink-soft">{t(`web.${prefix}_intro`, args)}</p>

      <article className="mt-10">
        <StepTimeline steps={items} layout="stacked" />
        {children && <div className="mt-8 border-t border-line pt-8">{children}</div>}
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
