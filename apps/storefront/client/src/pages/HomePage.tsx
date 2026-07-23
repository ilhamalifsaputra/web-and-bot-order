/**
 * TSX port of apps/storefront/views/home.njk (design.md §4.8) — hero, features,
 * categories, featured products, upcoming services, "Our Promise", real
 * testimonials, FAQ, and contact. Markup/classes copied verbatim apart from
 * the mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 *
 * Note: home.njk's stats band was already replaced by the static "Our
 * Promise" section (design.md §4.8, "not customer-count promises") before
 * this port — HomePageData.stats is fetched (API parity) but, like the NJK,
 * never rendered.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
  Box,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  CreditCard,
  Gamepad2,
  Headphones,
  KeyRound,
  LifeBuoy,
  MessageCircle,
  Package,
  PackageCheck,
  PackageSearch,
  QrCode,
  RotateCcw,
  Share2,
  Shield,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Tag,
  Ticket,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";
import { apiGet } from "../api/client";
import { motion } from "framer-motion";
import { hoverLift, staggerContainer, staggerItem } from "../lib/motion";
import type { HomePageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import Callout from "../components/shop/Callout";
import ProductCard from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import Skeleton from "../components/shop/Skeleton";
import StepTimeline from "../components/shop/StepTimeline";
import Stars from "../components/shop/Stars";
import EmptyState from "../components/shop/EmptyState";
import Price from "../components/shop/Price";
import "./HomePage.css";

const FAQ_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// One topic icon per question, for scanability — severity (if any) is
// conveyed by the Callout an answer renders in, not by this icon.
const FAQ_ICONS = [
  Zap,
  ShieldCheck,
  CreditCard,
  Timer,
  LifeBuoy,
  BadgeCheck,
  KeyRound,
  RotateCcw,
  Wrench,
  Tag,
  Coins,
];
// Only these 3 answers already read as a warning/cross-reference worth
// pulling out visually — every other answer stays plain text.
const FAQ_CALLOUTS: Partial<Record<number, "info" | "warning">> = { 3: "info", 8: "warning", 11: "warning" };
const HOW_STEPS = [1, 2, 3, 4];
const HOW_STEP_ICONS = [Package, ShoppingCart, QrCode, PackageCheck];
const TRUST_POINTS = [1, 2, 3, 4];
const SKELETON_CARDS = Array.from({ length: 3 }, (_, i) => i);
// Loose stagger positions for up to 3 hero product-preview cards — plain
// numbers/strings, not CSS transform strings, so framer-motion's own
// whileHover translateY composes correctly with this static rotation
// instead of one overwriting the other.
const HERO_CARD_STYLES: Array<{ top: string; right: string; rotate: number }> = [
  { top: "6%", right: "4%", rotate: -4 },
  { top: "40%", right: "20%", rotate: 3 },
  { top: "72%", right: "0%", rotate: -2 },
];

export default function HomePage() {
  const { data: ctx } = useShopContext();
  const { data } = useQuery({
    queryKey: ["home"],
    queryFn: () => apiGet<HomePageData>("/api/v1/pages/home"),
  });
  // Section reveal on scroll — port of home.njk's inline <script>: the same
  // document-wide querySelectorAll, same threshold/class toggling, same
  // no-IntersectionObserver / reduced-motion fallback (immediately visible,
  // also handled by the CSS `@media` rule in HomePage.css).
  //
  // STO-006: that mechanism has no safety net beyond real scrolling — a
  // screenshot/print/PDF tool, a non-scrolling crawler, or slow/erroring JS
  // left 5 of 7 sections permanently at `opacity:0`. A timeout forces every
  // `.reveal` visible after REVEAL_FALLBACK_MS regardless of intersection,
  // so no code path can leave content invisible forever.
  useEffect(() => {
    if (!data) return;
    const reveals = document.querySelectorAll<HTMLElement>(".reveal");
    if (!reveals.length) return;
    const REVEAL_FALLBACK_MS = 2000;
    const fallback = window.setTimeout(() => {
      reveals.forEach((r) => r.classList.add("visible"));
    }, REVEAL_FALLBACK_MS);
    if ("IntersectionObserver" in window) {
      const revObs = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add("visible");
              revObs.unobserve(e.target);
            }
          });
        },
        { threshold: 0.1 },
      );
      reveals.forEach((r) => revObs.observe(r));
      return () => {
        revObs.disconnect();
        window.clearTimeout(fallback);
      };
    }
    reveals.forEach((r) => r.classList.add("visible"));
    return () => window.clearTimeout(fallback);
  }, [data]);

  // STO-006/performance.md: rendering nothing while the initial query is
  // pending reads as a blank/broken page on a slow connection. A full
  // section-by-section skeleton would over-mimic a page this long — a
  // hero + featured-products placeholder (the above-the-fold content) is
  // enough to signal "loading" rather than "broken" (see AccountPage).
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="rounded-3xl bg-ink px-6 py-12 sm:px-10 sm:py-16 mb-12">
          <Skeleton className="h-5 w-28 bg-white/10" />
          <Skeleton className="mt-5 h-10 w-3/4 max-w-md bg-white/10" />
          <Skeleton className="mt-4 h-5 w-2/3 max-w-sm bg-white/10" />
          <div className="mt-7 flex flex-wrap gap-3">
            <Skeleton className="h-12 w-40 bg-white/10" />
            <Skeleton className="h-12 w-40 bg-white/10" />
          </div>
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {SKELETON_CARDS.map((i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const { hero_image, categories, products, testimonials, low_threshold, bot_username, wa_number } = data;
  // Real inventory only — never a fabricated/placeholder product. Fewer than
  // 2 available products means no composition at all (see homepage design spec).
  const heroProducts = products.length >= 2 ? products.slice(0, 3) : [];
  const fx = ctx?.fx;

  const contactCount = 1 + (wa_number ? 1 : 0) + (bot_username ? 1 : 0);
  const contactCols = contactCount === 3 ? "sm:grid-cols-3" : contactCount === 2 ? "sm:grid-cols-2" : "";

  return (
    <>
      {/* 1. Hero (design.md §4.8, mockup perbaikan) */}
      <section className="relative overflow-hidden rounded-3xl bg-ink px-6 py-12 sm:px-10 sm:py-16 mb-12">
        {hero_image ? (
          <>
            <img
              src={hero_image}
              alt=""
              aria-hidden="true"
              loading="eager"
              decoding="async"
              width={1600}
              height={600}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-linear-to-br from-ink/95 via-ink/90 to-pine-dark/80"></div>
          </>
        ) : (
          <div className="absolute inset-0 bg-linear-to-br from-ink via-ink to-pine-dark"></div>
        )}
        {/* Layered depth: two low-opacity glows -> reused .dot-grid texture -> soft vignette.
            All decorative, aria-hidden, and never intercept clicks. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-pine/20 blur-3xl"></div>
        <div aria-hidden="true" className="pointer-events-none absolute -left-10 bottom-0 h-56 w-56 rounded-full bg-grass/10 blur-3xl"></div>
        <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0"></div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-20 bg-[radial-gradient(ellipse_at_center,transparent_45%,var(--color-ink)_100%)]"
        ></div>
        <div className={`relative max-w-2xl ${heroProducts.length >= 2 ? "lg:max-w-xl" : ""}`}>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-wide text-grass">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("web.hero_badge")}
          </span>
          <h1 className="mt-5 text-4xl font-display font-bold leading-tight text-white sm:text-5xl">
            {t("web.hero_title")}
          </h1>
          <p className="mt-4 text-lg text-ink-faint">{t("web.hero_sub")}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <motion.a
              href="#produk"
              {...hoverLift}
              className="focus-on-dark inline-flex items-center gap-2 rounded-xl bg-pine px-5 py-3 font-semibold text-white hover:bg-pine-dark transition-colors shadow-soft hover:shadow-lift"
            >
              <ShoppingBag className="h-5 w-5" />
              {t("web.hero_cta")}
            </motion.a>
            <a
              href="#kontak"
              className="focus-on-dark inline-flex items-center gap-2 rounded-xl border border-white/20 px-5 py-3 font-semibold text-white hover:bg-white/15 transition-colors"
            >
              <MessageCircle className="h-5 w-5" />
              {t("web.hero_cta2")}
            </a>
          </div>
          {/* honest trust chips: capabilities/guarantees, no customer-count claims */}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/10 pt-5 text-sm text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-amber-400" /> {t("web.badge_instant")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield className="h-4 w-4 text-grass" /> QRIS &amp; USDT
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle className="h-4 w-4 text-pine-tint" /> {t("web.feat_warranty")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Headphones className="h-4 w-4 text-violet-400" /> {t("web.badge_support")}
            </span>
          </div>
        </div>

        {heroProducts.length > 0 && (
          <div
            data-testid="hero-product-preview"
            className="pointer-events-none absolute inset-y-0 right-0 hidden w-[36%] lg:block"
          >
            <motion.div
              className="relative h-full"
              variants={staggerContainer}
              initial="initial"
              animate="animate"
            >
              {heroProducts.map((p, i) => (
                <motion.div
                  key={p.slug}
                  variants={staggerItem}
                  {...hoverLift}
                  className="pointer-events-auto absolute w-48 rounded-2xl border border-white/15 bg-white/10 p-3 shadow-lift backdrop-blur-md"
                  style={{ top: HERO_CARD_STYLES[i]!.top, right: HERO_CARD_STYLES[i]!.right, rotate: HERO_CARD_STYLES[i]!.rotate }}
                >
                  <Link to={`/p/${p.slug}`} className="focus-on-dark flex items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/10">
                      {p.image ? (
                        <img
                          src={p.image}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          width={44}
                          height={44}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Package className="h-5 w-5 text-white/70" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-white">{p.name}</span>
                      <Price value={p.from_price} fx={fx} size="text-xs" />
                    </span>
                  </Link>
                </motion.div>
              ))}
            </motion.div>
          </div>
        )}
      </section>

      {/* 2. Fitur / keunggulan */}
      <section className="mt-16 reveal">
        <p className="text-center text-sm font-semibold uppercase tracking-wide text-pine">
          {t("web.features_kicker")}
        </p>
        <h2 className="mt-1 text-center font-display text-3xl font-bold text-ink">{t("web.features_title")}</h2>
        <p className="mt-2 text-center text-ink-soft">{t("web.features_sub")}</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-pine-tint text-pine">
              <Zap className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold text-ink">{t("web.feat_instant")}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t("web.feat_instant_d")}</p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-grass-tint text-grass-dark">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold text-ink">{t("web.feat_secure")}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t("web.feat_secure_d")}</p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-amberx-tint text-amberx">
              <CheckCircle className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold text-ink">{t("web.feat_warranty")}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t("web.feat_warranty_d")}</p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-violet-50 text-violet-600">
              <Headphones className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold text-ink">{t("web.feat_support")}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t("web.feat_support_d")}</p>
          </div>
        </div>
      </section>

      {/* 2b. Cara pesan — a numbered stepper, deliberately NOT a fourth card
          grid: the features above and "Our Promise" below already use that
          shape, and stacking three identical grids made the page read as one
          undifferentiated wall. The connector line only appears at `lg`, where
          all four steps genuinely sit on one row. */}
      <section className="mt-16 reveal" id="how-to-order">
        <p className="text-center text-sm font-semibold uppercase tracking-wide text-pine">{t("web.how_kicker")}</p>
        <h2 className="mt-1 text-center font-display text-3xl font-bold text-ink">{t("web.how_title")}</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-ink-soft">{t("web.how_sub")}</p>

        <div className="mt-10">
          <StepTimeline
            layout="grid"
            steps={HOW_STEPS.map((n, idx) => ({
              icon: HOW_STEP_ICONS[idx]!,
              title: t(`web.how_s${n}`),
              description: t(`web.how_s${n}_d`),
            }))}
          />
        </div>
      </section>

      {/* 3. Kategori */}
      {categories.length > 0 && (
        <section className="mt-16 reveal" id="kategori">
          <p className="text-sm font-semibold uppercase tracking-wide text-pine">{t("web.categories")}</p>
          <h2 className="mt-1 font-display text-2xl font-bold text-ink">{t("web.categories_title")}</h2>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => (
              <Link
                key={c.slug}
                to={`/c/${c.slug}`}
                className="group flex items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-xs transition hover:border-pine-tint hover:shadow"
              >
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-pine-tint text-2xl group-hover:scale-105 transition-transform">
                  {c.emoji ? c.emoji : <Box className="w-6 h-6 text-pine" />}
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink truncate">{c.name}</h3>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-pine">
                    {t("web.view_products")}
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 4. Produk unggulan */}
      <section id="produk" className="mt-16 reveal">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-pine">{t("web.featured_kicker")}</p>
            <h2 className="mt-1 font-display text-2xl font-bold text-ink">{t("web.new_arrivals")}</h2>
          </div>
          {categories.length > 0 && (
            <a href="#kategori" className="inline-flex items-center gap-1 group text-sm font-medium text-pine hover:text-pine-dark">
              {t("web.view_by_category")} <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
          )}
        </div>

        {products.length > 0 ? (
          // STO-018: a single product in a 3-column grid leaves two-thirds of
          // the row empty, reading as broken rather than a deliberate
          // one-item shelf — clamp to one column with a capped width instead
          // of stretching an isolated card across the full row.
          <div className={`mt-5 grid gap-5 ${products.length === 1 ? "max-w-sm" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        ) : (
          <div className="mt-5">
            <EmptyState
              icon={PackageSearch}
              title={t("web.catalog_empty")}
              description={t("web.catalog_empty_desc")}
              action={{ label: t("web.nav_categories"), to: "/categories" }}
            />
          </div>
        )}
      </section>

      {/* Layanan mendatang (rencana integrasi — statis, tanpa backend) */}
      <section className="mt-16 reveal">
        <p className="text-sm font-semibold uppercase tracking-wide text-pine">{t("web.upcoming_kicker")}</p>
        <h2 className="mt-1 font-display text-2xl font-bold text-ink">{t("web.upcoming_title")}</h2>
        <p className="mt-2 text-ink-soft">{t("web.upcoming_sub")}</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="flex items-start gap-4 rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600">
              <Share2 className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-ink">{t("web.sosmed_title")}</h3>
                <span className="inline-flex items-center gap-1 rounded-full bg-amberx-tint px-2.5 py-1 text-xs font-medium text-amberx">
                  <Clock className="h-3.5 w-3.5" /> {t("web.coming_soon")}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{t("web.sosmed_desc")}</p>
            </div>
          </div>
          <div className="flex items-start gap-4 rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-pine-tint text-pine">
              <Gamepad2 className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-ink">{t("web.topup_title")}</h3>
                <span className="inline-flex items-center gap-1 rounded-full bg-amberx-tint px-2.5 py-1 text-xs font-medium text-amberx">
                  <Clock className="h-3.5 w-3.5" /> {t("web.coming_soon")}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{t("web.topup_desc")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Our Promise (replaces vanity numbers) */}
      <section className="mt-16 overflow-hidden rounded-3xl bg-pine px-6 py-10 text-white sm:px-10 reveal">
        <h2 className="text-center font-display text-2xl font-bold sm:text-3xl">{t("web.promise_title")}</h2>
        <p className="mt-1 text-center text-pine-tint">{t("web.promise_sub")}</p>
        <div className="mt-8 grid gap-6 text-center sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/15">
              <Zap className="h-6 w-6" />
            </div>
            <p className="mt-3 font-semibold">{t("web.promise_delivery")}</p>
            <p className="text-sm text-pine-tint">{t("web.promise_delivery_d")}</p>
          </div>
          <div>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/15">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <p className="mt-3 font-semibold">{t("web.promise_payment")}</p>
            <p className="text-sm text-pine-tint">{t("web.promise_payment_d")}</p>
          </div>
          <div>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/15">
              <CheckCircle className="h-6 w-6" />
            </div>
            <p className="mt-3 font-semibold">{t("web.promise_warranty")}</p>
            <p className="text-sm text-pine-tint">{t("web.promise_warranty_d")}</p>
          </div>
          <div>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/15">
              <Headphones className="h-6 w-6" />
            </div>
            <p className="mt-3 font-semibold">{t("web.promise_replies")}</p>
            <p className="text-sm text-pine-tint">{t("web.promise_replies_d")}</p>
          </div>
        </div>
      </section>

      {/* 5b. Kenapa aman — every claim here is verifiable in this codebase
          (auto-verified payments, order history on the account, ticketed
          support, reviews only from delivered orders), which is the same bar
          "Our Promise" set when it replaced the invented stats band. Rendered
          as a checklist inside one card so it reads differently from the pine
          promise block directly above it. */}
      <section className="mt-16 reveal">
        <div className="rounded-3xl border border-line bg-card p-6 shadow-xs sm:p-10">
          <p className="text-sm font-semibold uppercase tracking-wide text-pine">{t("web.trust_kicker")}</p>
          <h2 className="mt-1 font-display text-2xl font-bold text-ink">{t("web.trust_title")}</h2>
          <p className="mt-2 max-w-2xl text-ink-soft">{t("web.trust_sub")}</p>
          <ul className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {TRUST_POINTS.map((n) => (
              <li key={n} className="flex items-start gap-3">
                <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-grass" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink">{t(`web.trust_${n}`)}</h3>
                  <p className="mt-1 text-sm text-ink-soft">{t(`web.trust_${n}_d`)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6. Testimoni — ulasan ASLI dari pesanan yang sudah terkirim (≥4★ dengan
          komentar). Section disembunyikan saat belum ada ulasan, supaya tidak
          ada testimoni karangan di halaman. */}
      {testimonials.length > 0 && (
        <section className="mb-12 reveal">
          <div className="text-center mb-8">
            <p className="text-xs font-semibold tracking-widest uppercase text-pine mb-2">{t("web.testi_kicker")}</p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-ink tracking-tight">
              {t("web.testi_title")}
            </h2>
            <p className="mt-2 text-sm text-ink-soft">{t("web.testi_sub")}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {testimonials.map((review, i) => (
              <div key={i} className="card card-pad flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-pine flex items-center justify-center text-white font-display font-bold text-sm shrink-0">
                    {review.initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-sm font-semibold text-ink">{review.name}</div>
                    <div className="text-xs text-ink-faint">
                      {t("web.testi_buyer")} · {review.product}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Stars rating={review.rating} />
                  </div>
                </div>
                <p className="text-sm text-ink-soft leading-relaxed border-t border-line pt-3 italic">
                  “{review.comment}”
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 7. FAQ */}
      <section className="mt-16 reveal">
        <p className="text-center text-sm font-semibold uppercase tracking-wide text-pine">{t("web.faq_kicker")}</p>
        <h2 className="mt-1 text-center font-display text-3xl font-bold text-ink">{t("web.faq_title")}</h2>
        <p className="mt-2 text-center text-ink-soft">{t("web.faq_sub")}</p>
        <div className="mx-auto mt-8 max-w-3xl space-y-4">
          {FAQ_NUMBERS.map((n) => {
            const Icon = FAQ_ICONS[n - 1]!;
            const calloutVariant = FAQ_CALLOUTS[n];
            return (
              <details
                key={n}
                className="faq group rounded-2xl border border-line bg-card px-5 py-1"
                open={n === 1}
              >
                <summary className="flex cursor-pointer items-center gap-3 p-6 font-semibold text-ink">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sand text-ink-soft">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="flex-1">{t(`web.faq_q${n}`)}</span>
                  <ChevronDown className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-6 pb-6">
                  {calloutVariant ? (
                    <Callout variant={calloutVariant}>{t(`web.faq_a${n}`)}</Callout>
                  ) : (
                    <p className="text-sm leading-relaxed text-ink-soft">{t(`web.faq_a${n}`)}</p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      {/* 8. Kontak */}
      <section className="mt-16 reveal" id="kontak">
        <p className="text-center text-sm font-semibold uppercase tracking-wide text-pine">{t("web.contact_kicker")}</p>
        <h2 className="mt-1 text-center font-display text-3xl font-bold text-ink">{t("web.contact_title")}</h2>
        <p className="mt-2 text-center text-ink-soft">{t("web.contact_sub")}</p>

        <div className={`mt-8 grid grid-cols-1 ${contactCols} gap-4 max-w-2xl mx-auto`}>
          {wa_number && (
            <a
              href={`https://wa.me/${wa_number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-xs transition hover:shadow-md"
            >
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-grass-tint">
                <svg className="h-6 w-6 text-grass-dark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-ink">WhatsApp</h3>
                <p className="mt-1 text-xs text-ink-faint">{t("web.contact_wa_sub")}</p>
              </div>
            </a>
          )}

          {bot_username && (
            <a
              href={`https://t.me/${bot_username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-xs transition hover:shadow-md"
            >
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#eff6ff]">
                <svg className="h-6 w-6 text-[#2563eb]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-ink">Telegram</h3>
                <p className="mt-1 text-xs text-ink-faint">{t("web.contact_tg_sub")}</p>
              </div>
            </a>
          )}

          <Link
            to="/account/support"
            className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-xs transition hover:shadow-md"
          >
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-pine-tint">
              <Ticket className="h-6 w-6 text-pine" />
            </div>
            <div>
              <h3 className="font-semibold text-ink">{t("web.contact_ticket")}</h3>
              <p className="mt-1 text-xs text-ink-faint">{t("web.contact_ticket_sub")}</p>
            </div>
          </Link>
        </div>

        <div className="mt-5 max-w-sm mx-auto">
          <div className="rounded-2xl bg-pine-tint p-4 flex items-start gap-2.5 text-sm text-ink-soft">
            <Clock className="h-4 w-4 text-pine shrink-0 mt-0.5" />
            <p>{t("web.contact_hours")}</p>
          </div>
        </div>
      </section>
    </>
  );
}
