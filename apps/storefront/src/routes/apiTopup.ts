/**
 * The storefront's cart-free instant top-up endpoints.
 *
 * `POST /topup/preview` + `POST /topup/order` (added by final-review fix N2)
 * are the direct-purchase rail behind InstantBuyPage.tsx: the buyer picks ONE
 * denomination and pays for it, and that selection never enters the cart table.
 * It used to — the page wrote its selection to the server-side cart purely so
 * `computeTotals` could see it, first CLEARING every line already there, so
 * merely opening a Top Up Game product page destroyed whatever the visitor had
 * been shopping for. Both routes below price and charge an ad-hoc line instead
 * (`checkoutView`'s new `adHocLine` parameter / `createOrderDirect`), so this
 * page now reads and writes no cart state at all.
 *
 * Neither route re-implements pricing, method gating, order creation or the
 * guest CSRF handoff: `/topup/preview` is `checkoutView` with one extra
 * argument, `/topup/order` calls the same `performDirect*` rails
 * (routes/checkout.ts) that wrap the very `createOrderDirect` +
 * `finalizeOrderPayment` / `completeOrderWithWalletCredit` functions the
 * Telegram bot has used in production for every single-denomination purchase
 * since before the storefront existed.
 *
 * `POST /topup/check-account` — the "kelebihan" (advantage) feature the
 * original UX reference site had over a plain form: a live in-game nickname
 * lookup on the buyer's account field, wired into InstantBuyPage.tsx's
 * debounced live-typing UX (Task 7, the final task of the Digiflazz top-up
 * pilot). Originally backed by KokinPay (@app/core/suppliers/kokinpay) alone,
 * a separate service from Digiflazz chosen specifically for this lookup.
 *
 * The nickname-multiprovider plan (Task 9) added a second, preferred path:
 * when the denomination's product is linked to a `Game`
 * (`Product.gameId`), the lookup instead runs through
 * `NicknameService` (@app/core/nickname/service) against every ENABLED
 * `ProviderGameMapping` row for that game, in ascending `priority` order,
 * trying kokinpay/vipreseller/melostore adapters in turn and falling
 * through on a retryable failure (network/HTTP/provider-side error) until
 * one answers or the list is exhausted. A mapping whose provider has no
 * credentials configured is skipped, not treated as a failure. The original
 * `nicknameCheckGameCode`-driven KokinPay-only block above still runs
 * verbatim as the fallback for a denomination with NO `gameId` — it is
 * legacy, not deleted, since plenty of denominations may never get a `Game`
 * link. The two paths are mutually exclusive per request: `gameId`, when
 * present, always wins over `nicknameCheckGameCode`.
 *
 * The region-check block below is deliberately NOT part of this
 * `gameId` branch — it stays gated on `expectedRegionCode` +
 * `nicknameCheckGameCode` exactly as it always has, regardless of whether
 * `gameId` is also set on the same denomination. Extending region-check to
 * the multi-provider path is out of scope for this pilot.
 *
 * Region-check Task C added a second, fully independent lookup on the same
 * request/response cycle: a VIP-Reseller (@app/core/suppliers/vipreseller)
 * region check that flags `region_mismatch: true` when the account's live
 * region disagrees with the denomination's admin-declared
 * `expectedRegionCode`. "Fully independent" is load-bearing here — the
 * KokinPay nickname-check and the VIP-Reseller region-check must each run
 * (or gracefully skip) regardless of whether the OTHER provider's
 * credentials/config are present. That's why, past the three shared
 * early-return gates below, this handler builds ONE `response` object and
 * runs both provider blocks in their own try/catch, each only setting its
 * own fields on `response` — never an early `reply.send()` per branch, which
 * would let one provider's return skip the other's check entirely.
 *
 * Reuses `nicknameCheckGameCode` as the VIP-Reseller game code too (see
 * Region-check Task C's brief) — there is deliberately no separate
 * "VIP-Reseller game code" admin field, so the region-check can only ever
 * run when `nicknameCheckGameCode` is ALSO set, in addition to
 * `expectedRegionCode`. This is a documented pilot-scope limitation, not a
 * bug.
 *
 * CRITICAL, per the plan's explicit instruction: this endpoint must NEVER
 * surface an error to the buyer or block checkout. Every non-happy path —
 * no nicknameCheckGameCode configured for the denomination, no KokinPay
 * credentials set, no expectedRegionCode configured, no VIP-Reseller
 * credentials set, or either live supplier call throwing (network/HTTP
 * failure) — degrades to that provider's fields simply being absent from
 * `response`. The client (InstantBuyPage.tsx) treats `available: false` /
 * `region_mismatch` absent as "show nothing, the field behaves exactly as it
 * does today" — silent degradation, not a visible failure state. This is a
 * read-only, unauthenticated, no-DB-write convenience lookup, so there is
 * nothing here for logAdminAction to audit.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  prisma,
  createGuestUser,
  getDenomination,
  getDenominationWithProduct,
  getKokinpayCreds,
  getVipResellerCreds,
  getMelostoreCreds,
  getEnabledProviderMappingsForGame,
} from "@app/db";
import { checkGameNickname } from "@app/core/suppliers/kokinpay";
import { checkGameRegion } from "@app/core/suppliers/vipreseller";
import { NicknameService, type NicknameServiceProviderEntry } from "@app/core/nickname/service";
import { createKokinpayNicknameProvider } from "@app/core/nickname/kokinpayProvider";
import { createVipResellerNicknameProvider } from "@app/core/nickname/vipresellerProvider";
import { createMelostoreNicknameProvider } from "@app/core/nickname/melostoreProvider";
import { logger } from "@app/core/logger";
import { OrderCurrency } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Denomination } from "@prisma/client";
import { optionalCustomer, type Customer } from "../plugins/auth";
import {
  clientIp,
  nicknameCheckRateLimited,
  checkoutPreviewRateLimited,
  guestCheckoutRateLimited,
} from "../rateLimit";
import { checkoutView, performDirectCheckout, performDirectWalletCheckout } from "./checkout";
import { csrfOk } from "./cart";
import { normalizeGuestEmail, sendGuestOrderCodeEmail, withGuestCsrf } from "./api";
import { establishSession } from "./auth";
import { constantTimeEqual } from "../auth";

interface CheckAccountResponse {
  available: boolean;
  valid?: boolean;
  nickname?: string | null;
  region_mismatch?: boolean;
}

const NOT_AVAILABLE: CheckAccountResponse = { available: false };

/** Shared body shape of the two instant-buy routes below. */
interface TopupLineBody {
  denomination_id?: number;
  qty?: number;
  voucher_code?: string;
}

/**
 * The requested denomination, or null when it isn't one this flow may sell.
 *
 * Mirrors `POST /cart`'s own validation (routes/api.ts) — an id that isn't a
 * positive integer, doesn't exist, or is deactivated is refused here, before
 * anything is priced and (on the order route) before any user row or order row
 * is written. Live stock is deliberately NOT checked here: `createOrderDirect`
 * allocates stock per unit inside the order transaction and throws
 * `error.out_of_stock` there, which is the only place that answer can't be
 * stale by the time it matters.
 */
async function resolveTopupDenomination(rawId: unknown): Promise<Denomination | null> {
  const denominationId = Number(rawId);
  if (!Number.isInteger(denominationId) || denominationId <= 0) return null;
  const denom = await getDenomination(prisma, denominationId);
  if (!denom || !denom.isActive) return null;
  return denom;
}

/**
 * The requested quantity, or null when it's out of range for this denomination.
 *
 * This pilot's UI always buys exactly one unit (InstantBuyPage.tsx has no qty
 * stepper), but `qty` arrives from the network, so the range is enforced here
 * rather than assumed. The Digiflazz single-unit rule is the same one `POST
 * /cart` and the guest-cart merge already enforce (final-review N1 fix): the
 * supplier dispatch poller can only ever place ONE supplier top-up per order
 * and then marks the WHOLE order delivered, so a multi-unit order for such a
 * SKU would charge the buyer for units they can never receive.
 */
function resolveTopupQuantity(rawQty: unknown, denom: Denomination): number | null {
  const qty = rawQty == null ? 1 : Number(rawQty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return null;
  if (denom.autoDeliverySource === "digiflazz" && qty !== 1) return null;
  return qty;
}

/**
 * Turn an anonymous `POST /topup/order` into a real (guest) `User` + session,
 * or send the failure response and return null.
 *
 * Sibling of `establishGuestCustomer` (routes/api.ts) for the cart-free rail,
 * with the SAME ordering discipline: every check that can reject the request
 * without touching the database runs before `createGuestUser`, so a malformed
 * or throttled request never leaves an orphan user row behind. It keeps that
 * function's email rule (`normalizeGuestEmail`, shared, not copied), its
 * wallet-method rejection, its per-IP `guestCheckoutRateLimited` throttle
 * placed last among the validations but still before any write, and its CSRF
 * handback contract (see `withGuestCsrf`).
 *
 * The one check it does NOT have is that function's step (c), "the guest cart
 * cookie resolves to something buyable" — this flow has no cart. Its
 * equivalent, "the requested `denomination_id` is a real, active denomination",
 * is `resolveTopupDenomination` above, which the caller runs BEFORE this
 * function for exactly the same reason: a request with nothing buyable behind
 * it must be refused before a user row exists. There is likewise no cart to
 * migrate — `establishSession` still merges any unrelated cart cookie the
 * visitor happens to be carrying into their new account, exactly as it does on
 * login, which preserves those lines rather than touching them on this flow's
 * behalf.
 */
async function establishGuestTopupCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const body = req.body as { method?: string; guest_email?: string } | undefined;

  // (a) Contact email — same shape/length rule, and the same deliberate
  // decision not to cross-check it against registered accounts (that would
  // make this endpoint an account-existence oracle).
  const email = normalizeGuestEmail(body?.guest_email);
  if (!email) {
    void reply.code(400).send({ error: "web.guest_email_invalid" });
    return null;
  }

  // (b) Balance payment methods need a wallet, and a guest has none.
  const method = (body?.method ?? "").toLowerCase();
  if (method === "wallet_idr" || method === "wallet_usdt") {
    void reply.code(400).send({ error: "web.pay_method_unavailable" });
    return null;
  }

  // (c) Per-IP throttle. Guest checkout mints a fresh user per order, so the
  // per-user MAX_PENDING_ORDERS cap can never bite for a guest — this is the
  // only thing standing between an abuser and unbounded user/order rows plus
  // tied-up stock reservations. Shares one quota with the cart-based guest
  // checkout, so opening a second rail didn't double the budget.
  if (guestCheckoutRateLimited(clientIp(req))) {
    void reply.code(429).send({ error: "error.rate_limited" });
    return null;
  }

  const guestUser = await createGuestUser(prisma, { email });
  const session = await establishSession(req, reply, { id: guestUser.id, telegramId: guestUser.telegramId });
  return { ...session, user: guestUser };
}

const apiTopupRoutes: FastifyPluginAsync = async (app) => {
  // ---- POST /topup/preview — live totals for ONE denomination, no cart ----
  //
  // The exact JSON `GET /api/v1/checkout` returns (same `CheckoutData` type,
  // same OrderSummaryCard/PaymentMethodSelector on the client), priced from an
  // ad-hoc line instead of the buyer's cart. It is `checkoutView` with one
  // extra argument — deliberately not a second totals implementation, because
  // "the preview quotes a different number than checkout charges" is precisely
  // the bug class this branch has been closing everywhere money is computed
  // twice.
  //
  // Open to guests, exactly like `POST /checkout/voucher/preview`, and capped
  // by the SAME `checkoutPreviewRateLimited` quota for anonymous callers: this
  // is the same class of call — unauthenticated, fans out to eight
  // settings/credential lookups, and looks up whatever voucher code it is
  // handed regardless of ownership, so without a shared cap it is a
  // voucher-code oracle at line rate. Sharing the quota also means an attacker
  // can't reset that oracle by alternating between this route and the two
  // cart-based ones. Signed-in callers are never throttled by it.
  app.post<{ Body: TopupLineBody }>("/topup/preview", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
    if (!customer && checkoutPreviewRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const denom = await resolveTopupDenomination(req.body?.denomination_id);
    if (!denom) return reply.code(400).send({ error: "invalid_request" });
    const quantity = resolveTopupQuantity(req.body?.qty, denom);
    if (quantity === null) return reply.code(400).send({ error: "invalid_request" });

    const voucherCode = (req.body?.voucher_code ?? "").trim().toUpperCase() || null;
    return reply.send(
      await checkoutView(req, customer, voucherCode, null, { denominationId: denom.id, quantity }),
    );
  });

  // ---- POST /topup/order — place the direct purchase ----
  //
  // Structural twin of `POST /api/v1/checkout` (routes/api.ts): same CSRF gate
  // for signed-in callers, same guest-minting fall-through, and the same TWO
  // payment branches with the same response bodies — wallet credit settles
  // synchronously and answers `/account/orders/:code` (there is no pay page to
  // send the buyer to), every other method goes through a gateway and answers
  // `/checkout/:code/pay`. Each branch catches ValidationError on its own and
  // answers 400 with the guest CSRF token attached, so a guest whose session
  // was minted moments earlier in THIS request can retry.
  app.post<{
    Body: TopupLineBody & {
      method?: string;
      customer_data?: unknown;
      /** Guest checkout only — the contact address the order is tracked by.
       * Ignored entirely for a signed-in buyer. */
      guest_email?: string;
    };
  }>("/topup/order", async (req, reply) => {
    const signedIn = await optionalCustomer(req);
    if (signedIn) {
      // Header-only, byte-for-byte as POST /api/v1/checkout gates itself (not
      // ./cart's `csrfOk`, which also accepts a body field — an order-creating
      // route holds the stricter of the two rules). Guests are not CSRF-checked
      // for the same reason they aren't there: they have no session to ride.
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !constantTimeEqual(token, signedIn.csrf)) {
        return reply.code(403).send({ error: "csrf_failed" });
      }
    }

    // Validated BEFORE the guest branch below, so a request with nothing
    // buyable behind it is refused before any user row is written — the
    // cart-free equivalent of establishGuestCustomer's own empty-cart check.
    const denom = await resolveTopupDenomination(req.body?.denomination_id);
    if (!denom) return reply.code(400).send({ error: "invalid_request" });
    const quantity = resolveTopupQuantity(req.body?.qty, denom);
    if (quantity === null) return reply.code(400).send({ error: "invalid_request" });
    const line = { denominationId: denom.id, quantity };

    const customer = signedIn ?? (await establishGuestTopupCustomer(req, reply));
    if (!customer) return; // the guest branch already sent its 4xx/429
    // True only when `customer` came from establishGuestTopupCustomer above —
    // decides whether the response has to carry the freshly minted session's
    // CSRF token (see withGuestCsrf).
    const isGuest = !signedIn;

    const method = (req.body?.method ?? "").toLowerCase();
    const voucherCode = (req.body?.voucher_code ?? "").trim().toUpperCase() || null;

    // Wallet credit — no gateway, settles synchronously. Only ever reachable
    // for a signed-in buyer: establishGuestTopupCustomer rejects these tokens.
    if (method === "wallet_idr" || method === "wallet_usdt") {
      try {
        const { orderCode } = await performDirectWalletCheckout(
          customer,
          line,
          method === "wallet_idr" ? OrderCurrency.IDR : OrderCurrency.USDT,
          voucherCode,
          req.body?.customer_data,
        );
        return reply
          .code(201)
          .send(withGuestCsrf({ order_code: orderCode, pay_url: `/account/orders/${orderCode}` }, isGuest, customer));
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(400).send(withGuestCsrf({ error: e.key }, isGuest, customer));
        }
        throw e;
      }
    }

    try {
      const { orderCode } = await performDirectCheckout(customer, line, method, voucherCode, req.body?.customer_data);

      // Mail the recovery code to guests only, keyed on the BUYER'S ROW
      // (`user.isGuest`) rather than on `isGuest` above — a retry after a
      // failed guest attempt arrives WITH the session that attempt minted, so
      // it takes the signed-in branch, and that shopper (no account, no
      // password) is exactly who this email exists for. Same reasoning, same
      // helper, as POST /api/v1/checkout.
      const guestEmail = customer.user.isGuest ? customer.user.guestEmail : null;
      const emailSent = guestEmail ? await sendGuestOrderCodeEmail(req, guestEmail, orderCode) : false;

      const body = { order_code: orderCode, pay_url: `/checkout/${orderCode}/pay` };
      return reply.code(201).send(withGuestCsrf(guestEmail ? { ...body, email_sent: emailSent } : body, isGuest, customer));
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(400).send(withGuestCsrf({ error: e.key }, isGuest, customer));
      }
      throw e;
    }
  });

  app.post<{ Body: { denomination_id?: number; id?: string; server?: string } }>(
    "/topup/check-account",
    async (req, reply) => {
      // Spent even by requests that go on to degrade below — this is a
      // live-typing lookup fired on every debounced keystroke, so the quota
      // has to bound call volume regardless of how the request resolves.
      if (nicknameCheckRateLimited(clientIp(req))) {
        return reply.code(429).send(NOT_AVAILABLE);
      }

      const denominationId = Number(req.body?.denomination_id);
      const accountId = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (!Number.isInteger(denominationId) || denominationId <= 0 || !accountId) {
        // Malformed input degrades the same as "no check configured" — this
        // endpoint has no error shape for the buyer to see.
        return reply.send(NOT_AVAILABLE);
      }

      const denomination = await getDenominationWithProduct(prisma, denominationId);
      // Shared prerequisite for the nickname-check side: either the new
      // `gameId` link (Task 9) or the legacy `nicknameCheckGameCode` must be
      // present, or there is nothing to look up. Checked together with the
      // null-denomination case so `denomination` is narrowed non-null for the
      // rest of this handler. Note this does NOT gate the region-check block
      // below, which has its own independent prerequisite
      // (`expectedRegionCode && nicknameCheckGameCode`, still legacy-only).
      const gameId = denomination?.product?.gameId ?? null;
      const legacyGameCode = denomination?.nicknameCheckGameCode ?? null;
      if (!denomination || (!gameId && !legacyGameCode)) return reply.send(NOT_AVAILABLE);

      const server = typeof req.body?.server === "string" ? req.body.server.trim() || undefined : undefined;

      // One shared response object — both the nickname-check branch and the
      // region-check block below only ADD fields to it, never `reply.send()`
      // on their own, so neither can short-circuit the other.
      const response: CheckAccountResponse = { available: false };

      if (gameId) {
        // --- Multi-provider nickname-check (Task 9, new). Tries every
        // ENABLED ProviderGameMapping row for this game in ascending
        // priority order via NicknameService, which itself already handles
        // per-provider retry-on-failure/fallthrough. A mapping whose
        // provider has no credentials configured is skipped up front, never
        // even added to `entries` — that's a config gap, not a lookup
        // failure, so it shouldn't count against the provider's turn. ---
        const mappings = await getEnabledProviderMappingsForGame(prisma, gameId);
        const entries: NicknameServiceProviderEntry[] = [];
        for (const mapping of mappings) {
          let provider: NicknameServiceProviderEntry["provider"] | null = null;
          if (mapping.provider === "kokinpay") {
            const creds = await getKokinpayCreds(prisma);
            if (creds) provider = createKokinpayNicknameProvider(creds);
          } else if (mapping.provider === "vipreseller") {
            const creds = await getVipResellerCreds(prisma);
            if (creds) provider = createVipResellerNicknameProvider(creds);
          } else if (mapping.provider === "melostore") {
            const creds = await getMelostoreCreds(prisma);
            if (creds) provider = createMelostoreNicknameProvider(creds);
          }
          // An unrecognized `mapping.provider` string (shouldn't happen —
          // admin UI only writes the three known values) is silently
          // skipped, same as a mapping with no credentials configured.
          if (provider) entries.push({ provider, gameCode: mapping.providerGameCode });
        }
        try {
          const result = await new NicknameService(entries).checkNickname({ target: accountId, server });
          if (result.status === "found") {
            response.available = true;
            response.valid = true;
            response.nickname = result.nickname;
          }
          // "not_found" / "no_providers_configured" → response stays
          // { available: false }, never surfaced as an error to the buyer.
        } catch (err) {
          // Defense in depth — every adapter (kokinpayProvider.ts,
          // vipresellerProvider.ts, melostoreProvider.ts) already catches its
          // own underlying HTTP client's throw and maps it to a
          // NicknameLookupOutcome, so NicknameService.checkNickname should
          // never actually throw. Caught anyway for the same silent-degrade
          // discipline as every other branch in this handler.
          logger.info(
            { err },
            "Multi-provider nickname check failed for one storefront lookup — degrading to no live check for this keystroke, buyer unaffected.",
          );
        }
      } else if (legacyGameCode) {
        const gameCode = legacyGameCode;
        // --- KokinPay nickname-check block (Task 7 logic, unchanged in
        // substance, restructured to set `response` instead of returning). ---
        const kokinpayCreds = await getKokinpayCreds(prisma);
        if (kokinpayCreds) {
          try {
            const result = await checkGameNickname(kokinpayCreds, { gameCode, id: accountId, server });
            response.available = true;
            response.valid = result.valid;
            response.nickname = result.nickname;
          } catch (err) {
            // The KokinPay client's own error message is already credential-free
            // (packages/core/src/suppliers/kokinpay.ts's guarantee) — safe to log,
            // but this is a debounced live-typing call, so a single flaky lookup
            // is expected background noise, not something worth an admin-facing
            // warn-level entry. The buyer never sees this at all: `response`
            // simply keeps `available: false`, same as "no check configured."
            logger.info(
              { err },
              "KokinPay nickname check failed for one storefront lookup — degrading to no live check for this keystroke, buyer unaffected.",
            );
          }
        }
      }

      // --- VIP-Reseller region-check block (Region-check Task C, new).
      // Fully independent of the nickname-check branch above (both the
      // gameId multi-provider path and the legacy KokinPay path): runs (or
      // skips) purely off `denomination.expectedRegionCode` +
      // `nicknameCheckGameCode` + its own credentials, and only ever ADDS
      // `region_mismatch: true` to `response` — every other outcome (not
      // configured, no creds, no country data, a throw) leaves
      // `region_mismatch` unset, never present in the JSON. Deliberately NOT
      // extended to gameId — see top-of-file comment. ---
      if (denomination.expectedRegionCode && legacyGameCode) {
        const gameCode = legacyGameCode;
        const vipResellerCreds = await getVipResellerCreds(prisma);
        if (vipResellerCreds) {
          try {
            const result = await checkGameRegion(vipResellerCreds, { gameCode, id: accountId, server });
            if (
              result.countryCode &&
              result.countryCode.toLowerCase() !== denomination.expectedRegionCode.toLowerCase()
            ) {
              response.region_mismatch = true;
            }
          } catch (err) {
            // checkGameRegion's own thrown errors are already static/
            // credential-free (packages/core/src/suppliers/vipreseller.ts's
            // guarantee), same info-level/no-buyer-visible-effect precedent
            // as the KokinPay catch block above.
            logger.info(
              { err },
              "VIP-Reseller region check failed for one storefront lookup — degrading to no region signal for this keystroke, buyer unaffected.",
            );
          }
        }
      }

      return reply.send(response);
    },
  );
};

export default apiTopupRoutes;
