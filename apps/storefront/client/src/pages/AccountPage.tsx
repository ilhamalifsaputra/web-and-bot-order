/**
 * TSX port of apps/storefront/views/account.njk, since restructured for the
 * phone: the page used to be one undifferentiated wall of five identical link
 * tiles plus four stat cards, which gives a thumb no sense of where anything
 * lives. Destinations are now grouped into labelled settings cards (orders,
 * profile, help) and the identity block leads the page, because the first
 * question this screen answers is "who am I signed in as".
 * account.njk's `<form action="/logout">` becomes a POST to
 * /api/v1/auth/logout followed by a full reload to "/" (clears the CSRF
 * meta + any client cache), same pattern as every other auth mutation.
 *
 * Redesigned into a dashboard shape: a summary grid (2x2 below `lg`, one row
 * of 4 at `lg` — wallet cards outweigh orders/referral visually, per this
 * shop's own "wallet is the thing customers check most" read of the account
 * page), a Quick Actions row for the three destinations that don't already
 * get a dedicated summary card, and the same three grouped menus as before
 * with a description line added to each row. `AccountData` only carries
 * name/order_count/referral_code/wallet_idr/wallet_usdt
 * (apps/storefront/src/routes/apiAccount.ts) — no avatar, email or fx rate,
 * so there's no email line and no "≈ Rp" conversion under the USDT balance.
 *
 * Below `lg` (mobile + tablet) the page is a single stacked column, byte-
 * identical to the original redesign. At `lg` and up it becomes a real
 * two-column dashboard instead of the same narrow column just centered in
 * more whitespace: quick actions + the grouped menu (merged into one side
 * panel) move into a left rail, and a right column adds three widgets built
 * from data this shop already exposes — recent orders (existing
 * `/api/v1/account/orders` endpoint, not a new one), a combined wallet
 * panel, and a fuller referral panel — rather than leaving that space empty
 * or inventing a "recent activity" feed this app has no customer-facing
 * source for (the audit log is admin-only, per CLAUDE.md). The whole page
 * also breaks out of Layout's shared `max-w-6xl` container at `lg` (a
 * self-contained full-bleed-then-recenter wrapper, so no other page is
 * affected) to reach the wider dashboard width this breakpoint asks for.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Coins,
  Copy,
  Gift,
  LifeBuoy,
  LogOut,
  Receipt,
  Settings,
  Star,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { AccountData, AccountOrderSummary, AccountOrdersData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr, formatNativeUsdt } from "../lib/format";
import { useMediaQuery } from "../lib/useMediaQuery";
import EmptyState from "../components/shop/EmptyState";
import Price from "../components/shop/Price";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import StatusBadge from "../components/shop/StatusBadge";
import Toast from "../components/shop/Toast";

interface MenuItem {
  href: string;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
}

export interface MenuGroup {
  headingKey: string;
  items: MenuItem[];
}

/**
 * The same five destinations as before, grouped so each card answers one
 * intent rather than making the visitor read all five labels every time.
 * Reviews sit with orders because you can only review something you bought.
 */
const MENU_GROUPS: MenuGroup[] = [
  {
    headingKey: "web.account_group_orders",
    items: [
      { href: "/account/orders", icon: Receipt, labelKey: "web.account_orders", descriptionKey: "web.account_orders_desc" },
      { href: "/account/reviews", icon: Star, labelKey: "web.account_reviews", descriptionKey: "web.account_reviews_desc" },
    ],
  },
  {
    headingKey: "web.account_group_profile",
    items: [
      { href: "/account/settings", icon: Settings, labelKey: "web.account_settings", descriptionKey: "web.account_settings_desc" },
    ],
  },
  {
    headingKey: "web.account_group_help",
    items: [
      { href: "/account/referral", icon: Gift, labelKey: "web.account_referral", descriptionKey: "web.account_referral_desc" },
      { href: "/account/support", icon: LifeBuoy, labelKey: "web.account_support", descriptionKey: "web.account_support_desc" },
    ],
  },
];

/**
 * What a guest account actually has behind it. A guest checked out without
 * registering: the account is synthetic, has no password, no referral code,
 * no reviews and no support tickets — so every other destination would open a
 * screen that can only be empty or refuse them. Orders are the one real thing
 * there, and the reason they have a session at all.
 */
const GUEST_HREFS = new Set(["/account/orders"]);

/**
 * Narrow a menu to what a guest can actually use, by destination rather than
 * by position. The first version filtered `MENU_GROUPS[0]`, which was only
 * correct while Orders happened to sit in the first group — reshuffling the
 * menu (an ordinary thing to do to an account page) would have handed guests
 * an empty nav with no way to reach the one screen they have, and nothing
 * would have failed to say so. Groups left with no items are dropped, so a
 * heading never renders over an empty list.
 *
 * Exported for its own test; the page itself only uses `GUEST_MENU_GROUPS`.
 */
export function guestMenuGroups(groups: MenuGroup[]): MenuGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => GUEST_HREFS.has(item.href)) }))
    .filter((group) => group.items.length > 0);
}

const GUEST_MENU_GROUPS: MenuGroup[] = guestMenuGroups(MENU_GROUPS);

interface QuickAction {
  href: string;
  icon: LucideIcon;
  labelKey: string;
}

/**
 * Orders and Referral already get a dedicated, more prominent summary card
 * below, so repeating them here would point at the same destination twice
 * with no extra information scent. These three are the account destinations
 * that don't otherwise get a card.
 */
const QUICK_ACTIONS: QuickAction[] = [
  { href: "/account/reviews", icon: Star, labelKey: "web.account_reviews" },
  { href: "/account/settings", icon: Settings, labelKey: "web.account_settings" },
  { href: "/account/support", icon: LifeBuoy, labelKey: "web.account_support" },
];

/**
 * There is no avatar image anywhere in the account data, and inventing an
 * upload feature is out of scope — an initial derived from the display name
 * still gives the header a fixed anchor point the eye can land on. `Array.from`
 * rather than `name[0]` so a name starting with an emoji or an astral-plane
 * character yields one whole glyph instead of half a surrogate pair.
 */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** One tappable destination: the whole row is the target, not just the label. */
function MenuRow({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.href}
      className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-sand"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-pine-tint text-pine">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-ink">{t(item.labelKey)}</span>
        <span className="block text-sm text-ink-soft">{t(item.descriptionKey)}</span>
      </span>
      {/* The chevron is the affordance that says "this navigates"; it carries
          no information the label doesn't, so screen readers skip it. */}
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
    </Link>
  );
}

/** A small icon-over-label shortcut tile for the Quick Actions row. */
function QuickActionTile({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.href}
      className="card flex min-h-[44px] flex-col items-center gap-2 px-2 py-3 text-center transition-colors hover:bg-sand"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sand text-ink-soft">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="text-xs font-semibold text-ink">{t(action.labelKey)}</span>
    </Link>
  );
}

interface SummaryCardCommon {
  icon: LucideIcon;
  labelKey: string;
  value: string;
  helperKey: string;
  /** Wallet cards get the heavier pine-tint treatment; orders/referral stay quiet. */
  emphasized?: boolean;
}

type SummaryCardProps =
  | (SummaryCardCommon & { as: "link"; href: string })
  | (SummaryCardCommon & { as: "button"; onClick: () => void })
  | (SummaryCardCommon & { as: "static" });

/**
 * One summary tile, in three flavors: a real link (Orders, since it
 * navigates), a button (Referral, since tapping it copies rather than
 * navigates), or a plain static card (both wallet balances — there is no
 * top-up or transaction-history page to link to, so it stays read-only
 * rather than pointing at a destination that doesn't exist).
 */
function SummaryCard(props: SummaryCardProps) {
  const { icon: Icon, labelKey, value, helperKey, emphasized } = props;
  const wellClass = emphasized ? "bg-pine-tint text-pine" : "bg-sand text-ink-soft";
  const valueClass = emphasized
    ? "stat-value tabular text-xl! break-words sm:text-2xl!"
    : "stat-value tabular text-lg! break-words sm:text-xl! font-semibold";

  const inner = (
    <>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${wellClass}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="stat-label mt-3 block">{t(labelKey)}</span>
      <span className={valueClass}>{value}</span>
      <span className="stat-sub block">{t(helperKey)}</span>
    </>
  );

  const className = "card card-pad flex min-h-[44px] flex-col items-start text-left";

  if (props.as === "link") {
    return (
      <Link to={props.href} className={`${className} transition-colors hover:bg-sand`}>
        {inner}
      </Link>
    );
  }
  if (props.as === "button") {
    return (
      <button type="button" onClick={props.onClick} className={`${className} transition-colors hover:bg-sand`}>
        {inner}
      </button>
    );
  }
  return <div className={className}>{inner}</div>;
}

/** One order row inside the desktop Recent Orders widget. */
function RecentOrderRow({ order, fx }: { order: AccountOrderSummary; fx: string | null | undefined }) {
  return (
    <Link
      to={`/account/orders/${order.code}`}
      className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-sand"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-xs font-semibold text-pine">{order.code}</span>
        <span className="block truncate text-sm text-ink-soft">{order.items}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <StatusBadge value={order.status} />
        <Price value={order.total} fx={fx} size="text-xs" />
      </span>
    </Link>
  );
}

export default function AccountPage() {
  const [toastText, setToastText] = useState<string | null>(null);
  // Tailwind's `lg` breakpoint — where the two-column dashboard kicks in.
  // Distinct from `useIsDesktop()` (768px) used elsewhere in this app for the
  // table-vs-cards swap; this page's split happens at a wider point.
  const isDashboard = useMediaQuery("(min-width: 1024px)");

  const { data, error } = useQuery({
    queryKey: ["account"],
    queryFn: () => apiGet<AccountData>("/api/v1/account"),
    retry: false,
  });

  // Recent Orders widget only exists at the `lg` dashboard split, so only
  // fetch it there rather than on every phone visit to this page.
  const { data: recentOrders } = useQuery({
    queryKey: ["account-orders-preview"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    enabled: isDashboard,
    retry: false,
  });
  const { data: shopCtx } = useShopContext();
  // Guest checkout (Task 6). The marker rides on the context payload this
  // page already fetches — no extra endpoint. An older/mocked payload without
  // the field reads as a normal registered customer, which keeps the full
  // menu: the safe direction to be wrong in for someone who really is signed
  // in.
  const isGuest = shopCtx?.is_guest === true;
  const menuGroups = isGuest ? GUEST_MENU_GROUPS : MENU_GROUPS;

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account"));
    }
  }, [error]);

  const logoutMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/api/v1/auth/logout", {}),
    // Full reload (not navigate()) — clears the CSRF meta along with the session.
    onSuccess: () => window.location.assign("/"),
  });

  function copyReferral() {
    if (!data) return;
    navigator.clipboard.writeText(data.referral_code);
    setToastText(t("web.copied"));
  }

  // STO-006/performance.md: rendering nothing while the initial query is
  // pending reads as a blank/broken page on a slow connection — show a
  // skeleton shaped like the loaded layout instead.
  if (!data) {
    return (
      <div className="lg:relative lg:left-1/2 lg:w-screen lg:-translate-x-1/2">
        <div
          aria-busy="true"
          aria-label={t("web.loading")}
          className="space-y-8 lg:mx-auto lg:max-w-[1280px] lg:px-6"
        >
          <div className="card card-pad flex items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-40" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="card card-pad flex flex-col items-start gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="w-full space-y-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-6 w-20" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3 lg:max-w-sm">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="card flex flex-col items-center gap-2 px-2 py-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-3 w-12" />
              </div>
            ))}
          </div>
          <div className="space-y-6 lg:max-w-sm">
            {MENU_GROUPS.map((group) => (
              <div key={group.headingKey} className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <div className="card divide-y divide-line">
                  {group.items.map((item) => (
                    <div key={item.href} className="flex min-h-14 items-center gap-3 px-4 py-3">
                      <Skeleton className="h-9 w-9 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    // Full-bleed breakout at `lg`: escapes Layout's shared `max-w-6xl` (a
    // container every other page also uses) and recenters a wider box just
    // for this page, so the dashboard split below actually has room to
    // spread out instead of being squeezed into the same narrow column the
    // rest of the shop uses. No effect below `lg` — both wrapper divs are
    // unpositioned there, so mobile/tablet render exactly as before.
    <div className="lg:relative lg:left-1/2 lg:w-screen lg:-translate-x-1/2">
    <div className="space-y-8 lg:mx-auto lg:max-w-[1280px] lg:px-6">
      <Toast text={toastText} onDismiss={() => setToastText(null)} kind="success" />

      <h1 className="page-title">{t("web.account_title")}</h1>

      {/* Identity block. On a phone the sign-out button drops below the name
          and goes full width: sharing the row with a long name would squeeze
          both, and sign-out is the one destructive action here — it should be
          deliberate, not something the thumb brushes while scrolling. */}
      <div className="card card-pad flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span
            className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-pine-tint font-display text-xl font-semibold text-pine-dark"
            aria-hidden="true"
          >
            {initialOf(data.name)}
          </span>
          <div className="min-w-0">
            {/* Name stays its own text node (not concatenated into the
                greeting string) so it wraps predictably on a 320px screen
                and is independently addressable in tests/assistive tech. */}
            <div className="font-display text-lg font-semibold break-words text-ink">
              {t("web.account_greeting")} <span>{data.name}</span>
            </div>
          </div>
        </div>
        {/* Signing out costs a guest more than it costs a registered
            customer — there is no password to come back with, only the order
            code and email. Say so next to the button rather than letting them
            find out afterwards. */}
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <button
            type="button"
            className="btn btn-ghost w-full shrink-0 sm:w-auto"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate()}
          >
            {logoutMutation.isPending && <Spinner />}
            <LogOut className="w-4 h-4" aria-hidden="true" /> {t("web.nav_logout")}
          </button>
          {isGuest && (
            <p className="max-w-xs text-xs leading-relaxed text-ink-soft sm:text-right">
              {t("web.guest_account_note")}
            </p>
          )}
        </div>
      </div>

      {/* Summary grid: 2x2 below `lg`, one row of 4 at `lg`. Orders before
          referral, and both wallet balances carry heavier (pine-tint)
          styling than orders/referral so the numbers customers check most
          often read as the priority. */}
      {/* A guest has no wallet to spend and no referral code to share, so
          three of the four tiles would read "Rp0"/blank — one honest card
          beats four, three of which are about things they don't have. */}
      <div className={isGuest ? "grid grid-cols-1 gap-4 sm:max-w-xs" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
        <SummaryCard
          as="link"
          href="/account/orders"
          icon={Receipt}
          labelKey="web.account_orders"
          value={String(data.order_count)}
          helperKey="web.account_view_history"
        />
        {!isGuest && (
          <>
            <SummaryCard
              as="static"
              emphasized
              icon={Wallet}
              labelKey="web.account_credit_idr"
              value={formatIdr(data.wallet_idr)}
              helperKey="web.account_balance_available"
            />
            <SummaryCard
              as="button"
              onClick={copyReferral}
              icon={Gift}
              labelKey="web.account_referral"
              value={data.referral_code}
              helperKey="web.account_tap_to_copy"
            />
            <SummaryCard
              as="static"
              emphasized
              icon={Coins}
              labelKey="web.account_credit_usdt"
              value={formatNativeUsdt(data.wallet_usdt)}
              helperKey="web.account_balance_available"
            />
          </>
        )}
      </div>

      {/* Below `lg`: quick actions + grouped menu stack full-width, exactly
          as before. At `lg`: they become the dashboard's left rail (~1/3
          width) and a right column of widgets appears alongside them. The
          `space-y-8`/`lg:space-y-0` pair hands spacing duties to the grid's
          own `gap` once the split is active. */}
      <div className="space-y-8 lg:grid lg:grid-cols-12 lg:items-start lg:gap-6 lg:space-y-0">
        <div className="space-y-8 lg:col-span-4">
          {/* Quick Actions: shortcuts to the destinations that don't already
              have a dedicated summary card above. All three are closed to a
              guest, which would leave an empty row of tiles — so the whole
              section goes rather than being rendered hollow. */}
          {!isGuest && (
            <div className="space-y-2">
              <h2 className="stat-label px-1">{t("web.account_quick_actions")}</h2>
              <div className="grid grid-cols-3 gap-3">
                {QUICK_ACTIONS.map((action) => (
                  <QuickActionTile key={action.href} action={action} />
                ))}
              </div>
            </div>
          )}

          {/* Grouped destinations. Each group is a labelled <nav> so
              assistive tech gets the same "these three things are about
              help" grouping the headings give a sighted visitor. Below `lg`
              this is three separate cards (unchanged); at `lg` it becomes
              one merged side panel — a single render path chosen by
              `isDashboard`, not both kept in the DOM and toggled with CSS
              (this app's own useMediaQuery.ts convention: two renderable
              shapes for the same content is wasted work and ambiguous to
              assistive tech/tests, so only one ever mounts). */}
          {isDashboard ? (
            <div className="card overflow-hidden">
              {menuGroups.map((group) => (
                <nav key={group.headingKey} aria-label={t(group.headingKey)}>
                  <div className="bg-sand/60 px-4 py-2 text-xs font-semibold tracking-wide text-ink-soft uppercase">
                    {t(group.headingKey)}
                  </div>
                  <div className="divide-y divide-line">
                    {group.items.map((item) => (
                      <MenuRow key={item.href} item={item} />
                    ))}
                  </div>
                </nav>
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {menuGroups.map((group) => (
                <nav key={group.headingKey} aria-label={t(group.headingKey)} className="space-y-2">
                  <h2 className="stat-label px-1">{t(group.headingKey)}</h2>
                  <div className="card divide-y divide-line overflow-hidden">
                    {group.items.map((item) => (
                      <MenuRow key={item.href} item={item} />
                    ))}
                  </div>
                </nav>
              ))}
            </div>
          )}
        </div>

        {/* Right column — desktop only. Recent Orders reuses the existing
            /api/v1/account/orders endpoint (no new API); the Wallet and
            Referral panels restate data already on this page in a fuller
            format. There's no customer-facing "recent activity" feed to
            build a fourth widget from (the audit log is admin-only), so
            three real widgets fill this column rather than a fabricated
            fourth. */}
        <div className="hidden space-y-6 lg:col-span-8 lg:block">
          <div className="card card-pad">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="section-title">{t("web.account_recent_orders")}</h2>
              <Link to="/account/orders" className="link text-sm whitespace-nowrap">
                {t("web.account_view_history")}
              </Link>
            </div>
            {!recentOrders ? (
              <div className="space-y-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            ) : recentOrders.orders.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title={t("web.no_orders")}
                action={{ label: t("web.nav_products"), to: "/products" }}
                bare
              />
            ) : (
              <div className="divide-y divide-line">
                {recentOrders.orders.slice(0, 4).map((order) => (
                  <RecentOrderRow key={order.code} order={order} fx={shopCtx?.fx} />
                ))}
              </div>
            )}
          </div>

          {/* Both panels below are about things a guest account doesn't have
              (a balance, a referral code), so they don't render for one. */}
          {!isGuest && (
          <div className="card card-pad">
            <h2 className="section-title mb-4">{t("web.account_wallet_overview")}</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="min-w-0">
                <span className="stat-label block">{t("web.account_credit_idr")}</span>
                <span className="stat-value tabular block text-2xl!">{formatIdr(data.wallet_idr)}</span>
              </div>
              <div className="min-w-0">
                <span className="stat-label block">{t("web.account_credit_usdt")}</span>
                <span className="stat-value tabular block text-2xl!">{formatNativeUsdt(data.wallet_usdt)}</span>
              </div>
            </div>
            <p className="stat-sub mt-4">{t("web.account_wallet_note")}</p>
          </div>
          )}

          {!isGuest && (
          <div className="card card-pad">
            <h2 className="section-title mb-1">{t("web.account_referral")}</h2>
            <p className="page-lead mb-4">{t("web.referral_hint")}</p>
            <div className="flex items-center gap-3">
              <span className="stat-value font-mono text-xl! select-all">{data.referral_code}</span>
              <button type="button" className="btn btn-soft btn-sm whitespace-nowrap" onClick={copyReferral}>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" /> {t("web.copy")}
              </button>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
