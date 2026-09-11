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
 * page, and serving them different text is cloaking. Both render the SAME
 * `t()` keys in the SAME order (title, intro, then _hN/_pN per block); only
 * the layout/typography differs.
 *
 * Two treatments, per `page-templates.md` §7:
 *   - `variant="prose"` (default) — a single narrow column (~768px) of
 *     long-form prose: `<h1>` + section `<h2>`s + paragraphs/lists, no card
 *     chrome, text directly on `paper`. Used by /terms, /privacy, /refund
 *     (legal copy) and /about (informational, not a sequence).
 *   - `variant="timeline"` — the numbered `StepTimeline` (badge + connector).
 *     Used only by /how-to-order, which is a genuine ordered sequence with a
 *     merged QRIS/USDT payment step (the `render` escape hatch).
 *
 * `steps` supplies the per-block icon (timeline only) and the optional
 * per-block callout wrapper; it is optional so an unconfigured caller still
 * renders (a generic icon, no callouts) rather than breaking.
 */
import { Link } from "react-router-dom";
import { FileText, LifeBuoy, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import Card from "../ui/Card";
import Callout, { type CalloutVariant } from "./Callout";
import StepTimeline, { type StepItem } from "./StepTimeline";

export interface StaticPageStep {
  /** Per-block badge icon. Only rendered by `variant="timeline"`; prose pages
   *  omit it (they have no badges). */
  icon?: LucideIcon;
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
  /** Prose (default) = plain narrow column; timeline = numbered StepTimeline. */
  variant?: "prose" | "timeline";
  /** Page-specific block appended after the numbered ones (see PrivacyPage). */
  children?: React.ReactNode;
}

export default function StaticPage({
  prefix,
  blocks,
  args = {},
  steps,
  variant = "prose",
  children,
}: StaticPageProps) {
  const config: StaticPageStep[] =
    steps ?? Array.from({ length: blocks }, (_, i) => ({ icon: FileText, block: i + 1 }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-semibold text-ink sm:text-4xl">
        {t(`web.${prefix}_title`)}
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t(`web.${prefix}_intro`, args)}</p>

      {variant === "timeline" ? (
        <TimelineBody prefix={prefix} args={args} config={config}>
          {children}
        </TimelineBody>
      ) : (
        <ProseBody prefix={prefix} args={args} config={config}>
          {children}
        </ProseBody>
      )}

      {/* Never strand the reader on a policy page — every one of them ends on
          the same forward action the policies themselves point at. */}
      <Card className="mt-12">
        <h2 className="font-display text-lg font-semibold text-ink">{t("web.static_help_title")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">{t("web.static_help_body")}</p>
        <Link to="/help" className="btn btn-primary mt-4">
          <LifeBuoy className="h-4 w-4" />
          {t("web.static_help_cta")}
        </Link>
      </Card>
    </div>
  );
}

interface BodyProps {
  prefix: string;
  args: Record<string, unknown>;
  config: StaticPageStep[];
  children?: React.ReactNode;
}

/** Plain long-form prose: `<h2>` + paragraph per block, no badges, no cards. */
function ProseBody({ prefix, args, config, children }: BodyProps) {
  return (
    <article className="mt-10 space-y-8">
      {config.map((step, idx) => {
        if (step.render) return <div key={idx}>{step.render}</div>;
        const n = step.block ?? idx + 1;
        const body = t(`web.${prefix}_p${n}`, args);
        return (
          <section key={idx}>
            <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">
              {t(`web.${prefix}_h${n}`)}
            </h2>
            <div className="mt-3">
              {step.callout ? (
                <Callout variant={step.callout}>{body}</Callout>
              ) : (
                <p className="text-base leading-relaxed text-ink-soft">{body}</p>
              )}
            </div>
          </section>
        );
      })}
      {children && <div className="mt-10 border-t border-line pt-10">{children}</div>}
    </article>
  );
}

/** Numbered sequence: the shared `StepTimeline` (badge + icon + connector). */
function TimelineBody({ prefix, args, config, children }: BodyProps) {
  const items: StepItem[] = config.map((step, idx) => {
    const icon = step.icon ?? FileText;
    if (step.render) {
      return { icon, description: step.render };
    }
    const n = step.block ?? idx + 1;
    const body = t(`web.${prefix}_p${n}`, args);
    return {
      icon,
      title: t(`web.${prefix}_h${n}`),
      description: step.callout ? (
        <Callout variant={step.callout}>{body}</Callout>
      ) : (
        <p className="leading-relaxed text-ink-soft">{body}</p>
      ),
    };
  });

  return (
    <article className="mt-10">
      <StepTimeline steps={items} layout="stacked" />
      {children && <div className="mt-8 border-t border-line pt-8">{children}</div>}
    </article>
  );
}
