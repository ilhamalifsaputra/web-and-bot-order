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
  Box,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Gamepad2,
  Headphones,
  MessageCircle,
  Share2,
  Shield,
  ShieldCheck,
  ShoppingBag,
  Ticket,
  Zap,
} from "lucide-react";
import { apiGet } from "../api/client";
import type { HomePageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import ProductCard from "../components/shop/ProductCard";
import Stars from "../components/shop/Stars";
import "./HomePage.css";

const FAQ_NUMBERS = [1, 2, 3, 4, 5];

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
  useEffect(() => {
    if (!data) return;
    const reveals = document.querySelectorAll<HTMLElement>(".reveal");
    if (!reveals.length) return;
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
      return () => revObs.disconnect();
    }
    reveals.forEach((r) => r.classList.add("visible"));
    return undefined;
  }, [data]);

  if (!data) return null;

  const { hero_image, categories, products, testimonials, low_threshold, bot_username, wa_number } = data;
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
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-linear-to-br from-ink/95 via-ink/85 to-pine-dark/80"></div>
          </>
        ) : (
          <div className="absolute inset-0 bg-linear-to-br from-ink via-pine-dark to-pine"></div>
        )}
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-pine/20 blur-3xl"></div>
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-wide text-grass">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("web.hero_badge")}
          </span>
          <h1 className="mt-5 text-4xl font-display font-bold leading-tight text-white sm:text-5xl">
            {t("web.hero_title")}
          </h1>
          <p className="mt-4 text-lg text-ink-faint">{t("web.hero_sub")}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="#produk"
              className="inline-flex items-center gap-2 rounded-xl bg-pine px-5 py-3 font-semibold text-white hover:bg-pine-dark transition-colors shadow-soft"
            >
              <ShoppingBag className="h-5 w-5" />
              {t("web.hero_cta")}
            </a>
            <a
              href="#kontak"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-5 py-3 font-semibold text-white hover:bg-white/10 transition-colors"
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
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-card p-10 text-center text-ink-faint mt-5">
            {t("web.catalog_empty")}
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
        <div className="mx-auto mt-8 max-w-3xl space-y-3">
          {FAQ_NUMBERS.map((n) => (
            <details
              key={n}
              className="faq group rounded-2xl border border-line bg-card px-5 py-1"
              open={n === 1}
            >
              <summary className="flex cursor-pointer items-center justify-between p-6 font-semibold text-ink">
                {t(`web.faq_q${n}`)}
                <ChevronDown className="h-5 w-5 text-ink-faint transition-transform group-open:rotate-180" />
              </summary>
              <div className="px-6 pb-6 text-sm text-ink-soft leading-relaxed">{t(`web.faq_a${n}`)}</div>
            </details>
          ))}
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
