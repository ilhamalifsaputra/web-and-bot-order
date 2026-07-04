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
import { prisma, setSetting, addToCart, getDenomination, getUserByTelegramId } from "@app/db";
import {
  makeCustomerSession,
  newJti,
  shopSessionJtiKey,
  verifyTelegramLoginResult,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { readGuestCart, writeGuestCart, resolveBotToken } from "../shop";

/** Only ever redirect to a local path (open-redirect guard). */
export const safeNext = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

type SessionUser = { id: number; telegramId: bigint | null };

/** Shared sign-in tail: merge guest cart, rotate jti, set the cookie. */
export async function establishSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
): Promise<void> {
  const guestCart = readGuestCart(req);
  for (const line of guestCart) {
    const denom = await getDenomination(prisma, line.p);
    if (denom?.isActive) await addToCart(prisma, user.id, line.p, line.q);
  }
  if (guestCart.length) writeGuestCart(reply, []);

  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  const { raw } = makeCustomerSession(user.id, user.telegramId, jti);
  void reply.setCookie(SHOP_COOKIE_NAME, raw, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: SHOP_SESSION_TTL_HOURS * 3600,
  });
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
