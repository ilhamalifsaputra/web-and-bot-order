/**
 * Task 16: the shop's brand/trust panel shown beside the four auth cards
 * (LoginPage, RegisterPage, ForgotPage, ResetPage). Those four routes sit
 * outside <Layout/> (App.tsx) — no header/footer at all — so a lone ~28rem
 * card floated on a flat background read as unfinished ("login page kosong
 * banget", the shop owner's complaint). This panel fills that space with
 * material the shop already owns: its own name/logo, the same trust strip
 * HomePage's hero uses (trust_instant / "QRIS & USDT" / feat_warranty /
 * badge_support), and the footer's policy links — no invented marketing copy.
 *
 * It also fixes a side effect of living outside <Layout/>: with no footer,
 * these pages were a navigational dead end with no route to /terms,
 * /privacy or /refund except a bare logo link back to "/".
 *
 * Rendered by each page inside the same flex container as the form card,
 * *after* it in DOM order with `lg:order-first` flipping it to the left
 * visually at the lg breakpoint. Keeping the card first in the DOM (not just
 * first on screen) means: (a) on mobile, where the container is a single
 * column, the form is literally the first thing in the document — nothing
 * pushes it down — and (b) a keyboard/screen-reader user tabs straight into
 * the form without first traversing this supplementary panel, which is why
 * these pages still don't need a skip-to-content link even though this panel
 * gives them more chrome than before (see the note in each page file).
 */
import { Link } from "react-router-dom";
import { CheckCircle, Headphones, Shield, Store, Zap } from "lucide-react";
import { useShopContext } from "./Layout";
import { t } from "../lib/i18n";
import TrustBadgeRow from "./ui/TrustBadgeRow";

const POLICY_LINKS = [
  { to: "/terms", key: "web.terms_title" },
  { to: "/privacy", key: "web.privacy_title" },
  { to: "/refund", key: "web.refund_title" },
] as const;

export default function AuthBrandPanel({ className = "" }: { className?: string }) {
  const { data: ctx } = useShopContext();
  const shopName = ctx?.shop_name ?? "";

  return (
    <div
      className={`w-full rounded-3xl bg-pine px-6 py-8 text-white sm:px-8 sm:py-10 lg:order-first ${className}`}
    >
      <Link to="/" className="flex items-center gap-2 text-white">
        {ctx?.logo_url ? (
          <img
            src={ctx.logo_url}
            alt={shopName}
            width={160}
            height={28}
            className="h-7 w-auto max-w-[10rem] object-contain"
          />
        ) : (
          <Store className="h-6 w-6" />
        )}
        <span className="font-display text-lg font-semibold">{shopName}</span>
      </Link>

      <p className="mt-3 text-sm text-pine-tint">{t("web.trust_badge")}</p>

      {/* Same four claims as HomePage's hero trust strip — shared
          <TrustBadgeRow> primitive, stacked for this narrower column. */}
      <TrustBadgeRow
        orientation="column"
        className="mt-6 text-pine-tint"
        items={[
          { icon: <Zap className="h-4 w-4 shrink-0 text-grass" />, label: t("web.trust_instant") },
          { icon: <Shield className="h-4 w-4 shrink-0 text-grass" />, label: "QRIS & USDT" },
          { icon: <CheckCircle className="h-4 w-4 shrink-0 text-pine-tint" />, label: t("web.feat_warranty") },
          { icon: <Headphones className="h-4 w-4 shrink-0 text-pine-tint" />, label: t("web.badge_support") },
        ]}
      />

      <ul className="mt-8 flex flex-wrap gap-x-4 gap-y-2 border-t border-white/15 pt-5 text-xs text-pine-tint">
        {POLICY_LINKS.map(({ to, key }) => (
          <li key={to}>
            <Link to={to} className="hover:text-white hover:underline">
              {t(key)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
