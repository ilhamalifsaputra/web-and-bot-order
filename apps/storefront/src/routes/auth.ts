/**
 * Customer session plumbing + the Telegram Login Widget callback.
 *
 * The HTML login/register forms were deleted on the React SPA cutover
 * (docs/REACT_STOREFRONT_MIGRATION.md Phase 5) — the SPA posts to their JSON
 * twins in routes/apiAuth.ts instead, which import `establishSession` and
 * `safeNext` from this file. `GET /auth/telegram` STAYS server-side (the
 * Telegram widget redirects the whole page, not an XHR): on success it
 * establishes the session and redirects like before; on failure it now
 * redirects to `/login?next=...&err=tg_failed|tg_unlinked` (303) instead of
 * re-rendering a Nunjucks page, so the React LoginPage can show the right
 * flash message. `POST /logout` was deleted on the account-area cutover
 * (docs/REACT_STOREFRONT_MIGRATION.md Phase 7) — the deleted account.njk's
 * logout form was its last consumer; AccountPage now posts to the JSON
 * twin, POST /api/v1/auth/logout (routes/apiAuth.ts).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import {
  prisma,
  setSetting,
  addToCart,
  getCart,
  cartCompositionLineOfCartItem,
  getDenomination,
  getUserByTelegramId,
  hasCartItem,
  adoptUserPreferredCurrencyIfUnset,
} from "@app/db";
import { cartAdditionError, type CartCompositionLine } from "@app/core/cartComposition";
import {
  makeCustomerSession,
  newJti,
  shopSessionJtiKey,
  verifyTelegramLoginResult,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
  type CustomerSession,
} from "../auth";
import { readGuestCart, writeGuestCart, resolveBotToken, requestCurrency } from "../shop";

/** Only ever redirect to a local path (open-redirect guard). Browsers read a
 * backslash as a forward slash and silently drop tab/CR/LF (and other control
 * characters), so `/\evil.com` or `/<TAB>/evil.com` would still land on
 * `//evil.com` — off-site. Refusing any backslash or control character
 * outright closes every such variant (backend audit Task C4); a real local
 * path never needs one. */
export const safeNext = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

type SessionUser = { id: number; telegramId: bigint | null };

/**
 * Shared sign-in tail: merge guest cart, adopt the display-currency cookie,
 * rotate jti, set the cookie.
 *
 * Returns the session payload it just minted. Most callers (the Telegram
 * widget callback below, the JSON login/register endpoints) only care about
 * the cookie side effect and ignore it; guest checkout (routes/api.ts POST
 * /checkout) needs the freshly issued `csrf` to build the `Customer` it hands
 * to performCheckout, and the cookie it just set is not readable back off
 * `req` within the same request.
 */
export async function establishSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
): Promise<CustomerSession> {
  const guestCart = readGuestCart(req);
  // The cart the merge builds ON TOP OF — the buyer's existing account cart,
  // which the guest lines join rather than replace.
  //
  // Before Trustance Phase 1 Task 3 this loop upserted every guest line blind,
  // with no composition awareness at all, and it is the one path that reaches
  // CartItem without passing `POST /cart`'s guard. So it could hand a buyer a
  // cart that BOTH checkout choke points then refuse — the buyer would sign in,
  // press Pay, get `error.cart_mixed_delivery`, and have no way forward except
  // working out for themselves which line to delete. (The checkout guards' own
  // comments name this path as the reason they exist.)
  //
  // Policy: merge greedily, skip what would conflict. Each guest line is
  // checked against the cart as it will actually be once the lines accepted
  // before it are in, so the result is always a cart `POST /cart` would have
  // allowed the buyer to build by hand. Chosen over the two alternatives
  // because it loses the least: dropping the whole guest cart on one bad line
  // throws away lines that were perfectly fine, and refusing the login itself
  // would let a stale cookie lock someone out of their account.
  //
  // Deterministic: cookie order decides, and the account cart always wins,
  // because it is the one the buyer can currently see.
  //
  // Skipped entirely when there is no guest cart to merge — that is the common
  // case for a plain sign-in, and it must not pay for a cart read.
  const mergedLines: CartCompositionLine[] = guestCart.length
    ? (await getCart(prisma, user.id)).map(cartCompositionLineOfCartItem)
    : [];
  let skipped = 0;
  for (const line of guestCart) {
    const denom = await getDenomination(prisma, line.p);
    if (!denom?.isActive) continue;
    const candidate: CartCompositionLine = {
      denominationId: denom.id,
      deliveryType: denom.deliveryType,
      autoDeliverySource: denom.autoDeliverySource,
    };
    if (cartAdditionError(mergedLines, candidate)) {
      skipped += 1;
      continue;
    }
    // Digiflazz single-unit guard (final-review N1 fix, Batch 1 review
    // finding): the guest cart cookie has no signature, so a crafted Cookie
    // header can carry any {p, q} pair straight past POST /cart's own guard
    // — this merge-on-login path is the one other place a Digiflazz-routed
    // line reaches CartItem without going through that route. addToCart
    // INCREMENTS an existing line rather than setting it, so even a
    // legitimate q:1 guest line would push an account that already holds
    // qty 1 of the same SKU to qty 2 — skip the merge entirely in that case
    // rather than letting it land above 1. (dispatchPendingDigiflazzOrders'
    // own defense-in-depth check remains the final backstop regardless.)
    if (denom.autoDeliverySource === "digiflazz") {
      if (!(await hasCartItem(prisma, user.id, line.p))) {
        await addToCart(prisma, user.id, line.p, 1);
        mergedLines.push(candidate);
      }
      continue;
    }
    await addToCart(prisma, user.id, line.p, line.q);
    // Only a line that became a NEW cart line widens the composition. An
    // upsert onto a denomination already present just bumped its quantity, and
    // quantity is not something either composition rule looks at.
    if (!mergedLines.some((l) => l.denominationId === candidate.denominationId)) {
      mergedLines.push(candidate);
    }
  }
  if (skipped > 0) {
    // Count only, never the ids — per CLAUDE.md's logging rules, and because a
    // clipped id list tells an operator nothing a count does not.
    logger.info(
      `Merged a guest cart into user ${user.id}'s account cart on sign-in and skipped ${skipped} of its ${guestCart.length} lines, ` +
        `because keeping them would have produced a cart that checkout refuses: an order may hold either one hand-fulfilled line ` +
        `(manual, manual_with_info, or a supplier-routed game top-up) or any number of instant-delivery lines, never both. ` +
        `The buyer keeps the lines that do fit; the skipped ones were never added, so nothing they can see was removed.`,
    );
  }
  if (guestCart.length) writeGuestCart(reply, []);

  // Display currency chosen before signing in (shop_currency cookie) becomes
  // the account's preference — once: the crud helper writes only when the
  // account has none yet and is not a guest row, so a stale cookie never
  // overwrites a choice already made here or in the bot.
  const cookieCurrency = requestCurrency(req);
  if (cookieCurrency) await adoptUserPreferredCurrencyIfUnset(prisma, user.id, cookieCurrency);

  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  const { raw, data } = makeCustomerSession(user.id, user.telegramId, jti);
  void reply.setCookie(SHOP_COOKIE_NAME, raw, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: SHOP_SESSION_TTL_HOURS * 3600,
  });
  return data;
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Record<string, string> }>("/auth/telegram", async (req, reply) => {
    const { next, ref, ...tgParams } = req.query;
    // Redirect back to the React LoginPage with an `err` code it already
    // understands (Cluster B, Task 1) instead of re-rendering HTML.
    const toLoginError = (err: "tg_failed" | "tg_unlinked") => {
      const params = new URLSearchParams({ next: safeNext(next), err });
      if (ref) params.set("ref", ref.slice(0, 16));
      return reply.code(303).redirect(`/login?${params.toString()}`);
    };
    // Verify with the LIVE bot token (DB setting wins) so it matches the live
    // bot username the widget signed with — a mismatched bot = "bad_hash".
    const result = verifyTelegramLoginResult(tgParams, await resolveBotToken());
    if (!result.ok) {
      logger.warn(
        `Rejected a Telegram login widget callback — reason: ${result.reason} ` +
          `("bad_hash" means the configured bot token doesn't match the bot username the widget signed with; ` +
          `"stale" means server clock skew or a replayed login link).`,
      );
      return toLoginError("tg_failed");
    }
    const auth = result.data;
    const user = await getUserByTelegramId(prisma, auth.id);
    if (!user) {
      return toLoginError("tg_unlinked");
    }
    if (user.banned) {
      return toLoginError("tg_failed");
    }
    await establishSession(req, reply, user);
    return reply.code(303).redirect(safeNext(next));
  });
};

export default authRoutes;
