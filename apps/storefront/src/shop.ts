/**
 * Per-request storefront context helpers: language (cookie, bilingual EN+ID),
 * shop identity (Settings), the USDT fx rate, and the guest cart cookie.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { prisma, getSetting } from "@app/db";
import { getUsdIdrRate } from "./pricing";
import { optionalCustomer, type Customer } from "./plugins/auth";

export const LANG_COOKIE = "shop_lang";
export const CART_COOKIE = "shop_cart";

/** Guest cart cookie payload: [{p: productId, q: qty}] (plan.md §5 decision D). */
export interface GuestCartLine {
  p: number;
  q: number;
}

/** "en" | "id" from the cookie, else the configured default. */
export function requestLang(req: FastifyRequest): string {
  const raw = (req.cookies[LANG_COOKIE] ?? "").toLowerCase();
  return raw === "id" || raw === "en" ? raw : config.DEFAULT_LANGUAGE;
}

/** Parse the guest-cart cookie defensively (bad cookie = empty cart). */
export function readGuestCart(req: FastifyRequest): GuestCartLine[] {
  const raw = req.cookies[CART_COOKIE];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
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
  void reply.setCookie(CART_COOKIE, JSON.stringify(lines), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
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
