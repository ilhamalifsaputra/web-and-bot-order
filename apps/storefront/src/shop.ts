/**
 * Per-request storefront context helpers: language (cookie, bilingual EN+ID),
 * shop identity (Settings), the USDT fx rate, and the guest cart cookie.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { botUsername } from "@app/core/runtime";
import { prisma, getSetting } from "@app/db";
import { getUsdIdrRate } from "./pricing";
import { optionalCustomer, type Customer } from "./plugins/auth";

const BOT_USERNAME_PLACEHOLDER = "yourbot"; // .env.example default; renders a broken widget
/** Live bot username for the storefront: DB `bot_username` setting wins, runtime/env
 *  fallback; the known placeholder and blank resolve to "" (treated as not configured). */
export async function resolveBotUsername(): Promise<string> {
  const fromDb = ((await getSetting(prisma, "bot_username")) ?? "").trim();
  const v = (fromDb || (botUsername() ?? "")).trim();
  return v.toLowerCase() === BOT_USERNAME_PLACEHOLDER ? "" : v;
}

/**
 * Live bot TOKEN for Telegram-login HMAC verification: DB `bot_token` setting
 * wins, env fallback — mirrors resolveBotCredentials' precedence. Resolved live
 * (not the boot-cached runtime) so the verification token stays consistent with
 * the live bot username the widget signs with: the Login Widget signs the
 * payload with the bot in `data-telegram-login`, and the server MUST verify with
 * that SAME bot's token. Setting the right token in admin then takes effect with
 * no restart. NEVER log the returned value (CLAUDE.md: never log secrets).
 */
export async function resolveBotToken(): Promise<string | undefined> {
  const fromDb = ((await getSetting(prisma, "bot_token")) ?? "").trim();
  const v = fromDb || (config.BOT_TOKEN ?? "").trim();
  return v || undefined;
}

export const LANG_COOKIE = "shop_lang";
/**
 * Guest cart cookie — VERSIONED at the catalog 3-tier cutover (Phase 3). Before
 * the rename `p` was the old `products.id` (the SKU); now `p` is a
 * `denominations.id`. The migration preserved old `products.id` values as
 * `denominations.id`, so a stale `shop_cart` cookie *usually* resolves to the
 * right row — but "usually" is not "always", so we hard-invalidate it:
 *   - the cookie NAME changed `shop_cart` → `shop_cart_v2`;
 *   - the payload is now `{v: 2, items: [{p, q}]}` and any payload missing
 *     `v === 2` is ignored;
 *   - the legacy `shop_cart` cookie is cleared on the next write.
 * Net effect: a pre-cutover cart can never resolve to a wrong denomination.
 */
export const CART_COOKIE = "shop_cart_v2";
/** The pre-cutover cookie name — read only to clear it. */
export const LEGACY_CART_COOKIE = "shop_cart";
/** Current guest-cart cookie schema version. Bump to invalidate again. */
export const CART_COOKIE_VERSION = 2;

/** Guest cart cookie line: {p: denomination id, q: qty}. */
export interface GuestCartLine {
  p: number;
  q: number;
}

/** Versioned guest-cart cookie envelope. */
interface GuestCartPayload {
  v: number;
  items: GuestCartLine[];
}

/** "en" | "id" from the cookie, else the configured default. */
export function requestLang(req: FastifyRequest): string {
  const raw = (req.cookies[LANG_COOKIE] ?? "").toLowerCase();
  return raw === "id" || raw === "en" ? raw : config.DEFAULT_LANGUAGE;
}

/**
 * Parse the versioned guest-cart cookie defensively (bad/old cookie = empty
 * cart). Only the current `{v: CART_COOKIE_VERSION, items: [...]}` envelope is
 * honoured; the legacy `shop_cart` cookie (a bare array, no version) is never
 * read here — see CART_COOKIE docs for the cutover rationale.
 */
export function readGuestCart(req: FastifyRequest): GuestCartLine[] {
  const raw = req.cookies[CART_COOKIE];
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw) as unknown;
    if (
      typeof payload !== "object" || payload === null ||
      (payload as GuestCartPayload).v !== CART_COOKIE_VERSION ||
      !Array.isArray((payload as GuestCartPayload).items)
    ) {
      return [];
    }
    return (payload as GuestCartPayload).items
      .filter(
        (x): x is GuestCartLine =>
          typeof x === "object" && x !== null &&
          Number.isInteger((x as GuestCartLine).p) &&
          Number.isInteger((x as GuestCartLine).q) &&
          (x as GuestCartLine).q > 0,
      )
      .map((x) => ({ p: x.p, q: Math.min(x.q, 99) }))
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function writeGuestCart(reply: FastifyReply, lines: GuestCartLine[]): void {
  const payload: GuestCartPayload = { v: CART_COOKIE_VERSION, items: lines };
  void reply.setCookie(CART_COOKIE, JSON.stringify(payload), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  // Evict any pre-cutover cookie so a stale denomination/SKU id can't linger.
  void reply.clearCookie(LEGACY_CART_COOKIE, { path: "/" });
}

export interface ShopContext {
  lang: string;
  /** USDT rate (Rupiah per 1 USDT) as a string for templates, or null = hidden. */
  fx: string | null;
  shop_name: string;
  shop_tagline: string;
  cart_count: number;
  active_nav: string;
  /** Current path — used by the language toggle to bounce back. */
  path: string;
  /** Verified customer (or null) — drives the header Account/Sign-in state. */
  customer: Customer | null;
  /** Favicon URL (web_favicon_url setting) or the bundled default. */
  favicon_url: string;
  /** Header logo URL (web_logo_url setting); empty = fall back to the store icon. */
  logo_url: string;
}

/**
 * Base template context for every storefront page: language, fx rate, shop
 * identity, the signed-in customer (if any) and the cart badge count — from
 * CartItem rows when signed in, the guest cookie otherwise (decision D).
 * Routes spread this into their view ctx.
 */
export async function shopContext(req: FastifyRequest, activeNav = "/"): Promise<ShopContext> {
  const customer = req.customer ?? (await optionalCustomer(req));
  const [fxRate, shopName, shopTagline, cartCount, favicon, logo] = await Promise.all([
    getUsdIdrRate(prisma),
    getSetting(prisma, "shop_name"),
    getSetting(prisma, "shop_tagline"),
    customer
      ? prisma.cartItem
          .aggregate({ where: { userId: customer.userId }, _sum: { quantity: true } })
          .then((r) => r._sum.quantity ?? 0)
      : Promise.resolve(readGuestCart(req).reduce((n, l) => n + l.q, 0)),
    getSetting(prisma, "web_favicon_url"),
    getSetting(prisma, "web_logo_url"),
  ]);
  return {
    lang: requestLang(req),
    fx: fxRate ? fxRate.toString() : null,
    shop_name: shopName ?? "Toko Digital",
    shop_tagline: shopTagline ?? "",
    cart_count: cartCount,
    active_nav: activeNav,
    path: req.url,
    customer,
    favicon_url: favicon || "/static/favicon.svg",
    logo_url: logo || "",
  };
}

/** Convert a Decimal-ish to a plain string for templates (autoescape-safe). */
export const dstr = (v: Decimal.Value | null | undefined): string | null =>
  v == null ? null : new Decimal(v).toString();
