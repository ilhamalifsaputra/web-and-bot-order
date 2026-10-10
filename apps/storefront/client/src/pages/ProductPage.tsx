/**
 * TSX port of apps/storefront/views/product.njk — image, denomination picker
 * (price/stock/qty-max/buy-vs-restock driven by the selected plan, replicating
 * the inline <script>'s `select()` behavior as React state instead of DOM
 * mutation), reviews. Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Bell,
  Package,
  ScrollText,
  Share2,
  ShieldCheck,
  ShoppingCart,
  Star,
  Zap,
} from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { t, tCount } from "../lib/i18n";
import { tError } from "../lib/errors";
import { formatPriceFor } from "../lib/format";
import { fadeUp } from "../lib/motion";
import { useIsDesktop } from "../lib/useMediaQuery";
import Breadcrumb from "../components/shop/Breadcrumb";
import Stars from "../components/shop/Stars";
import StockBadge from "../components/shop/StockBadge";
import DefaultThumb from "../components/shop/DefaultThumb";
import DenominationCard from "../components/shop/DenominationCard";
import StickyPurchaseBar from "../components/shop/StickyPurchaseBar";
import Alert from "../components/ui/Alert";
import FlashBadge, { FlashCountdown, FlashWasPrice } from "../components/shop/FlashBadge";
import ProductCard from "../components/shop/ProductCard";
import ErrorPage from "./ErrorPage";
import InstantBuyPage from "./InstantBuyPage";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";
import EmptyState from "../components/shop/EmptyState";

const revealProps = {
  variants: fadeUp,
  initial: "initial" as const,
  whileInView: "animate" as const,
  viewport: { once: true, margin: "-80px" },
};

/** Qty input contract: 1..min(99, available) for an auto denomination — a
 * non-auto denomination has no stock concept (available is always 0 by
 * design), so its cap is a flat 99 (matching the bot's MAX_QTY_PER_ORDER),
 * never tied to stock. */
function clampQty(raw: number, available: number, isAuto: boolean): number {
  const max = isAuto ? Math.max(1, Math.min(99, available)) : 99;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(Math.trunc(raw), max));
}

/** A denomination is purchasable when it's in stock (auto) OR when it's a
 * non-auto delivery type (manual/manual_with_info never have stock rows by
 * design — Task 2 skips stock reservation for them). Bug A fix (Task 6):
 * gating purely on `in_stock` made every manual-delivery product
 * permanently unbuyable on the storefront. */
function purchasable(d: { delivery_type: string; in_stock: boolean }): boolean {
  return d.delivery_type !== "auto" || d.in_stock;
}

/**
 * Share links for the product page.
 *
 * These are the platforms' own share URLs, not embedded share widgets: no
 * third-party script, no network request until the shopper actually clicks, and
 * nothing that could track visitors who don't. That keeps the page weight the
 * code-splitting work bought us, and keeps the shop free of trackers it never
 * asked for.
 *
 * Instagram is absent on purpose — it has no link-sharing URL, so a button for
 * it could only pretend to work.
 */
function ShareRow({ productName }: { productName: string }) {
  // Read at click time, not render time: the URL is right even if the router
  // changed it after mount, and this stays safe if the component ever renders
  // somewhere without a DOM.
  const targets = [
    {
      key: "whatsapp",
      label: "WhatsApp",
      href: (url: string) => `https://api.whatsapp.com/send?text=${encodeURIComponent(`${productName} — ${url}`)}`,
    },
    {
      key: "telegram",
      label: "Telegram",
      href: (url: string) =>
        `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(productName)}`,
    },
    {
      key: "x",
      label: "X",
      href: (url: string) =>
        `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(productName)}`,
    },
  ];

  return (
    <section className="mt-10">
      <h2 className="section-title mb-3">{t("web.share_title")}</h2>
      <div className="flex flex-wrap gap-2">
        {targets.map((target) => (
          <a
            key={target.key}
            href={target.href(window.location.href)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-soft btn-sm"
            aria-label={t("web.share_on", { platform: target.label })}
          >
            <Share2 className="w-3.5 h-3.5" /> {target.label}
          </a>
        ))}
      </div>
    </section>
  );
}

type RestockResult = "subscribed" | "already" | "unavailable" | "needs_telegram";

export default function ProductPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  const { data, error } = useQuery({
    queryKey: ["product", slug, ctx?.currency ?? null, ctx?.lang, ctx?.pricing_context],
    queryFn: () => apiGet<ProductPageData>(`/api/v1/pages/product/${slug}`),
    // Keep the instant checkout mounted while preferences reprice this product.
    // A different product must still start with its own loading state.
    placeholderData: (previous, query) => query?.queryKey[1] === slug ? previous : undefined,
    retry: false,
  });

  // T2: not covered by routeTitle.ts (RouteEffects.tsx) — the product name
  // isn't known until this fetch resolves. Called unconditionally, before
  // the early returns below, per the rules of hooks; useDocumentTitle itself
  // no-ops on undefined, so the previous page's title just stays put until
  // both the product and the shop name are in.
  useDocumentTitle(
    data && ctx?.shop_name ? `${data.product.name} — ${ctx.shop_name}` : undefined,
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [cartError, setCartError] = useState<unknown>(null);
  const isDesktop = useIsDesktop();
  // The live summary card is the sticky bar's sentinel: the bar exists only to
  // stand in for the real buy controls once they've scrolled away, so it stays
  // hidden while they're on screen rather than duplicating a button the shopper
  // is already looking at. Held as state (not a ref) so attaching the node
  // re-runs the observer effect — the node only exists after the query
  // resolves, and hooks can't wait for that.
  const [buyArea, setBuyArea] = useState<HTMLElement | null>(null);
  const [buyAreaVisible, setBuyAreaVisible] = useState(true);

  // A different product slug means a different denomination set — start over,
  // same as a fresh page load would.
  useEffect(() => {
    setSelectedId(null);
    setQty(1);
  }, [slug]);

  useEffect(() => {
    // Assume visible wherever IntersectionObserver is missing (jsdom, older
    // hosts): erring towards "hidden bar" keeps a purchase path that can't be
    // observed from covering content it can't prove is scrolled past.
    if (!buyArea || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      setBuyAreaVisible(entry ? entry.isIntersecting : true);
    });
    observer.observe(buyArea);
    return () => observer.disconnect();
  }, [buyArea]);

  const invalidateContext = () => queryClient.invalidateQueries({ queryKey: ["context"] });

  const addMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onMutate: () => setCartError(null),
    onSuccess: () => {
      invalidateContext();
      navigate("/cart");
    },
    onError: (err) => setCartError(err),
  });
  const buyMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onMutate: () => setCartError(null),
    onSuccess: () => {
      invalidateContext();
      navigate("/checkout");
    },
    onError: (err) => setCartError(err),
  });
  const restockMutation = useMutation({
    mutationFn: (denominationId: number) => apiPost<{ result: RestockResult }>(`/api/v1/restock/${denominationId}`, {}),
    onError: (err) => {
      if ((err as Error & { status?: number }).status === 401) {
        navigate(`/login?next=/p/${slug}`);
      }
    },
  });

  // A result belongs to the plan it was requested for — clear it on a switch.
  const resetRestock = restockMutation.reset;
  useEffect(() => {
    resetRestock();
  }, [selectedId, slug, resetRestock]);

  // Restock DMs go out over Telegram, so a signed-in account without a linked
  // Telegram can't be served — hide the button and say why instead. Anonymous
  // visitors keep it (tapping it sends them to log in).
  const needsTelegram = Boolean(ctx?.customer) && ctx?.customer?.telegram_linked === false;
  const restockResult = restockMutation.data?.result;
  const restockDone = restockResult === "subscribed" || restockResult === "already";
  const restockFeedbackKey = restockResult ? `web.restock_${restockResult}` : null;

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-4 w-48" />
        <div className="grid gap-8 lg:grid-cols-2">
          <Skeleton className="h-48 w-full sm:h-56 lg:h-64 xl:h-72" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const { product, denominations, reviews, related_products, low_threshold } = data;
  const fx = ctx?.fx;

  // Task 6 (Digiflazz instant-buy pilot): a category flagged checkoutFlow
  // "instant" renders the single-page buy flow instead of this page's usual
  // image/plan-picker + Cart→Checkout hop. InstantBuyPage re-fetches this
  // same product payload itself (same query key, so it hits the cache this
  // fetch just populated) rather than threading two dozen props through —
  // everything below this line is the unchanged catalog-flow path.
  if (product.template === "game") return <InstantBuyPage />;

  // Preselect the first in-stock plan, else the first plan — same order as
  // the script's `firstEnabled || radios[0]`.
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;
  if (!selected) return null;

  function selectDenomination(id: number, available: number, isAuto: boolean): void {
    setSelectedId(id);
    setQty((prev) => clampQty(prev, available, isAuto));
  }

  const buying = addMutation.isPending || buyMutation.isPending;
  const selectedIsAuto = selected.delivery_type === "auto";

  return (
    <>
      <Breadcrumb
        items={[
          { label: t("web.nav_home"), href: "/" },
          { label: product.category_name, href: `/c/${product.category_slug}` },
          { label: product.name },
        ]}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-10">
        {/* The product name spans both columns so it stays the first thing
            read on mobile (where the grid collapses to image → description →
            picker beneath it) while still heading the whole block on
            desktop. */}
        <h1 className="page-title md:col-span-2">{product.name}</h1>

        {/* Image + short description. `self-start` on this wrapper (not the
            image card) so the column doesn't stretch to the taller right
            column: a photo-less product (every Digiflazz import) would
            otherwise leave a tall empty DefaultThumb well with dead space
            below it. The description sits here, under the banner, moved from
            its old spot beneath the <h1>. */}
        <div className="self-start">
          <div className="card overflow-hidden">
            <div className="flex h-48 items-center justify-center bg-sand sm:h-56 lg:h-64 xl:h-72">
              {/* Bounded height (h-48..xl:h-72) with object-contain so the photo is
                  never cropped or stretched; see ProductCard for why the intrinsic
                  size is declared and why <picture> needs to be block. */}
              {product.image ? (
                <picture className="block w-full h-full">
                  {product.image_srcset && (
                    // Full width on phones, roughly half the grid on desktop.
                    <source
                      type="image/webp"
                      srcSet={product.image_srcset}
                      sizes="(max-width: 768px) 100vw, 600px"
                    />
                  )}
                  {/* Eager on purpose: this is the page's LCP element and the only
                      image above the fold on a phone, so deferring it would trade a
                      measurable delay for nothing. Everything below (the
                      related-products shelf) lazy-loads via ProductCard. The
                      width/height pair is what stops the text below from jumping
                      while it decodes — object-cover ignores the numbers for
                      painting, but the browser still uses their ratio to reserve
                      the box. */}
                  <img
                    src={product.image}
                    alt={product.name}
                    loading="eager"
                    decoding="async"
                    width={800}
                    height={600}
                    className="w-full h-full object-contain"
                  />
                </picture>
              ) : (
                <DefaultThumb kind={product.image_kind ?? "generic"} name={product.name} />
              )}
            </div>
          </div>

          {/* Optional lead paragraph, directly under the banner. Stays behind
              the `product.description &&` guard — Digiflazz products have
              `description: null` and must render nothing extra here. `mt-4`
              spaces it from the image card. No heading: it's a plain lead
              paragraph, same as it was under the <h1>. */}
          {product.description && (
            <div className="mt-4 text-sm leading-relaxed text-ink-soft whitespace-pre-line">
              {product.description}
            </div>
          )}
        </div>

        {/* Facts + denomination picker + actions */}
        <div id="product-detail" className="min-w-0">
          {/* Denomination cards — pick a plan (never a dropdown). The cheapest
              active denomination is preselected; selecting another updates the
              live price / stock / warranty and the checkout payload below. */}
          <div className="mt-6">
            <h2 className="section-title mb-3">{t("web.choose_plan")}</h2>
            <div id="denom-list" className="grid grid-cols-1 gap-3">
              {denominations.map((d) => (
                <DenominationCard
                  key={d.id}
                  d={d}
                  fx={fx}
                  lowThreshold={low_threshold}
                  checked={d.id === selected.id}
                  onChange={() => selectDenomination(d.id, d.available, d.delivery_type === "auto")}
                  iconKind={product.icon_kind}
                />
              ))}
            </div>
          </div>

          {/* Live summary — price/stock/warranty of the selected denomination.
              Also the sentinel the sticky mobile purchase bar watches, hence
              the id and the callback ref. */}
          <div id="buy-summary" ref={setBuyArea} className="card card-pad mt-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-2 flex-wrap">
                {/* `selected.price` already carries the flash discount — the
                    struck figure beside it is the pre-sale one. */}
                <div className="font-display font-semibold text-pine text-2xl">
                  {selected.canonical?.formattedPrice ?? formatPriceFor(selected.price, ctx?.currency ?? null, fx)}
                </div>
                {selected.flash && (
                  <FlashWasPrice value={selected.flash.base_price} endsAt={selected.flash.ends_at} />
                )}
              </div>
              {/* T18: reuse the same StockBadge the catalog card and each
                  denomination card use — it always renders a state (never
                  nothing, unlike the old ad-hoc `.chip` markup this replaced,
                  which returned null — and so showed no positive stock
                  signal at all — for a purchasable non-auto denomination). */}
              <div>
                <StockBadge
                  available={selected.available}
                  lowThreshold={low_threshold}
                  allNonAuto={!selectedIsAuto}
                />
              </div>
            </div>
            {selected.flash && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <FlashBadge percent={selected.flash.discount_percent} endsAt={selected.flash.ends_at} />
                <FlashCountdown endsAt={selected.flash.ends_at} />
              </div>
            )}
            {fx && <div className="text-xs text-ink-faint mt-1.5">{t("web.usdt_note")}</div>}

            {cartError !== null && (
              <Alert variant="banner" tone="error" className="mt-3 mb-0">
                {tError(cartError)}
              </Alert>
            )}

            {purchasable(selected) ? (
              // Buy Now / Add To Cart — both post the selected denomination_id.
              <form id="buy-form" className="mt-5 flex flex-wrap items-end gap-2" onSubmit={(e) => e.preventDefault()}>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-ink-soft" htmlFor="qty">
                    {t("web.qty")}
                  </label>
                  {/* inputMode="numeric" so phones open the digit keypad
                      instead of the full keyboard — type="number" alone
                      doesn't guarantee it on iOS. */}
                  <input
                    id="qty"
                    type="number"
                    inputMode="numeric"
                    name="qty"
                    value={qty}
                    min={1}
                    max={selectedIsAuto ? Math.max(1, Math.min(99, selected.available)) : 99}
                    className="field w-20! text-center"
                    onChange={(e) => setQty(clampQty(Number(e.target.value), selected.available, selectedIsAuto))}
                  />
                </div>
                <button
                  type="button"
                  id="btn-cart"
                  className="btn btn-soft"
                  disabled={buying}
                  onClick={() => addMutation.mutate({ denomination_id: selected.id, qty })}
                >
                  {addMutation.isPending && <Spinner />}
                  <ShoppingCart className="w-4 h-4" /> {t("web.add_to_cart")}
                </button>
                <button
                  type="button"
                  id="btn-buy"
                  className="btn btn-primary"
                  disabled={buying}
                  onClick={() => buyMutation.mutate({ denomination_id: selected.id, qty })}
                >
                  {buyMutation.isPending && <Spinner />}
                  <Zap className="w-4 h-4" /> {t("web.buy_now")}
                </button>
              </form>
            ) : (
              // Out-of-stock restock CTA (works only when logged in).
              <form id="restock-form" className="mt-3" onSubmit={(e) => e.preventDefault()}>
                {needsTelegram ? (
                  <p className="text-sm text-ink-soft">{t("web.restock_needs_telegram")}</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-soft"
                    disabled={restockMutation.isPending || restockDone}
                    onClick={() => restockMutation.mutate(selected.id)}
                  >
                    {restockMutation.isPending && <Spinner />}
                    <Bell className="w-4 h-4" /> {t("web.notify_restock")}
                  </button>
                )}
                {restockFeedbackKey && (
                  <p role="status" className="mt-2 text-sm text-ink-soft">
                    {t(restockFeedbackKey)}
                  </p>
                )}
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Product detail blocks — deliberately BELOW the buy area, not next to
          the short description: these are what a buyer reads while deciding,
          and putting three paragraphs above the plan picker would push the
          buy action off the first screen. Each block disappears when the
          admin left that field empty, so no headings dangle over nothing. */}
      {(product.what_you_get || product.terms || product.warranty_note) && (
        <motion.section {...revealProps} className="mt-10 card card-pad">
          {/* Deliberately not tabs or an accordion. All three blocks are short,
              and each one answers a question a hesitant buyer asks before
              paying — hiding two of them behind a tap costs a tap and hides
              the reassurance that closes the sale. What the wall of text
              actually lacked is landmarks, so each block now gets an icon,
              a heading that outranks the body, and a rule + generous gap
              separating it from the next: the eye can jump between the three
              on a phone without reading a word. */}
          {[
            { key: "what_you_get", icon: Package, title: t("web.what_you_get"), body: product.what_you_get },
            { key: "terms", icon: ScrollText, title: t("web.product_terms"), body: product.terms },
            { key: "warranty", icon: ShieldCheck, title: t("web.warranty"), body: product.warranty_note },
          ]
            // An empty field means the admin left it blank — no dangling heading.
            .filter((block) => Boolean(block.body))
            .map((block, index) => (
              <div
                key={block.key}
                className={index > 0 ? "mt-6 border-t border-line pt-6" : undefined}
              >
                <h2 className="flex items-center gap-2 font-display font-bold text-ink">
                  {/* Decorative: the heading text already names the block, so
                      announcing the icon too would just be noise. */}
                  <block.icon className="w-4 h-4 text-pine shrink-0" aria-hidden="true" />
                  {block.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft whitespace-pre-line">
                  {block.body}
                </p>
              </div>
            ))}
        </motion.section>
      )}

      <ShareRow productName={product.name} />

      {/* Reviews */}
      <motion.section {...revealProps} className="mt-10">
        <h2 className="section-title mb-3">{t("web.reviews")}</h2>
        {/* R4: the catalog card that links here already shows this same
            aggregate (ProductCard.tsx) — without it, the signal a shopper saw
            before clicking through disappears on arrival. Same rounding and
            the same `web.review_count` copy as the card, computed by the
            same aggregateRating helper server-side (cards.ts/pageData.ts), so
            the two can never disagree. `rating_count` is the TRUE total of
            non-hidden reviews, not `reviews.length` below — which is capped
            at 10 fetched rows — so this can (correctly) read higher than the
            number of review cards actually shown. */}
        {product.rating_count > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-ink-soft mb-4">
            <Stars rating={product.rating ?? 0} cls="w-4 h-4" />{" "}
            <span className="font-medium text-ink">{String(Math.round((product.rating ?? 0) * 10) / 10)}</span>
            <span className="text-ink-faint">· {tCount("web.review_count", product.rating_count)}</span>
          </div>
        )}
        {reviews.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-4 items-start">
            {reviews.map((r, i) => (
              <div key={i} className="card card-pad">
                <div className="flex items-center gap-2">
                  <Stars rating={r.rating} />
                  <span className="text-xs text-ink-faint">
                    {r.author} · {r.created_at_display}
                  </span>
                </div>
                {r.comment && (
                  <p className="text-sm text-ink-soft mt-2 whitespace-pre-line break-words">{r.comment}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          /* No CTA: the way to leave a review is to buy first, and the buy
             control is already the loudest thing on this page. */
          <EmptyState icon={Star} title={t("web.no_reviews")} description={t("web.no_reviews_desc")} />
        )}
      </motion.section>

      {/* STO-011: same-category "You might also like" shelf — this product
          detail page had no cross-sell/discovery path back into the catalog. */}
      {related_products.length > 0 && (
        <motion.section {...revealProps} className="mt-10">
          <h2 className="section-title mb-3">{t("web.related_products")}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {related_products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        </motion.section>
      )}

      {/* Reserved runway for the sticky bar. It's `fixed`, so it overlays the
          end of the page instead of pushing it — without this, the last shelf
          of related products would sit under the bar with no way to scroll it
          clear. Reserved for the whole mobile page rather than only while the
          bar is up, so the page height never changes underneath a scrolling
          thumb. */}
      {!isDesktop && (
        <div aria-hidden="true" style={{ height: "calc(4.75rem + env(safe-area-inset-bottom))" }} />
      )}

      {/* Sticky purchase bar — mobile only. This page is long (image, plan
          picker, three detail blocks, share row, reviews, related products),
          and everything below the fold is read *in order to decide to buy*;
          before this, deciding meant scrolling all the way back up to act on
          it. It reuses the same mutations and the same `selected` plan as the
          in-page controls, so there is exactly one purchase path, and it only
          appears once those controls have left the viewport (the `#buy-summary`
          IntersectionObserver sentinel above). Desktop keeps the buy card in
          view beside the image, so it needs none of this. Shared component
          (components.md "Sticky purchase bar") — Add to Cart stays in the
          in-page form only, so just `primaryAction` is passed. */}
      {!isDesktop && !buyAreaVisible && (purchasable(selected) || !needsTelegram) && (
        <StickyPurchaseBar
          ariaLabel={t("web.purchase_bar")}
          priceLabel={selected.canonical ? [selected.canonical.displayName, ...selected.canonical.qualifiers].join(" · ") : selected.duration_label || selected.name}
          price={selected.canonical?.formattedPrice ?? formatPriceFor(selected.price, ctx?.currency ?? null, fx)}
          primaryAction={
            purchasable(selected)
              ? {
                  label: t("web.buy_now"),
                  icon: <Zap className="w-4 h-4" />,
                  onClick: () => buyMutation.mutate({ denomination_id: selected.id, qty }),
                  pending: buyMutation.isPending,
                  disabled: buying,
                }
              : {
                  // Nothing to buy, but the bar still carries the one action
                  // that does exist — an empty bar is wasted screen on 320px.
                  label: restockFeedbackKey ? t(restockFeedbackKey) : t("web.notify_restock"),
                  icon: <Bell className="w-4 h-4" />,
                  onClick: () => restockMutation.mutate(selected.id),
                  pending: restockMutation.isPending,
                  disabled: restockMutation.isPending || restockDone,
                  variant: "soft",
                }
          }
        />
      )}
    </>
  );
}
