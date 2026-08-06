/**
 * Versioned JSON API (`/api/v1`) — a JSON twin of the existing HTML catalog,
 * cart and checkout routes for the storefront's own client-side JS / a future
 * first-party SPA reusing the existing logged-in browser session. Reuses the
 * SAME crud and business logic as the HTML routes (no duplicated logic, no
 * raw SQL): catalog reads go through packages/db/src/crud/catalog.ts, cart
 * mutations reuse loadCartLines/clampQty-equivalent rules from ./cart, and
 * checkout reuses performCheckout from ./checkout.
 *
 * Auth is the existing cookie session — not a new token/API-key scheme.
 * Unmatched routes and unexpected exceptions fall through to server.ts's
 * global handlers; only the success and named expected-failure paths below
 * return JSON here.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { sendMail } from "@app/core/mailer";
import { ValidationError } from "@app/core/errors";
import { DeliveryType, OrderCurrency } from "@app/core/enums";
import {
  prisma,
  getCategoryBySlug,
  getSetting,
  getSmtpCreds,
  listActiveCategories,
  listCatalogProducts,
  getCatalogProductBySlugWithDenominations,
  getDenomination,
  addToCart,
  countAvailableStock,
  createGuestUser,
  type CatalogProduct,
} from "@app/db";
import type { Category, Denomination } from "@prisma/client";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { productImage } from "../images";
import {
  readGuestCart,
  writeGuestCart,
  publicBase,
  CART_COOKIE,
  CART_COOKIE_VERSION,
  type GuestCartLine,
} from "../shop";
import { loadCartLines, loadGuestCartItems } from "./cart";
import { performCheckout, performWalletCheckout } from "./checkout";
import { establishSession } from "./auth";
import { clientIp, guestCheckoutRateLimited } from "../rateLimit";
import { constantTimeEqual } from "../auth";

interface CategoryJson {
  id: number;
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  image: string | null;
}

interface DenominationJson {
  id: number;
  name: string;
  price: string;
  stock: number;
  status: "in_stock" | "low_stock" | "out_of_stock";
}

interface ProductJson {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  image: string | null;
  category: CategoryJson;
  denominations: DenominationJson[];
}

function categoryJson(category: Category): CategoryJson {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    emoji: category.emoji,
    description: category.description,
    image: category.image,
  };
}

async function denominationJson(d: Denomination): Promise<DenominationJson> {
  const stock = await countAvailableStock(prisma, d.id);
  const status: DenominationJson["status"] =
    stock <= 0 ? "out_of_stock" : stock <= config.LOW_STOCK_THRESHOLD ? "low_stock" : "in_stock";
  return {
    id: d.id,
    name: d.name,
    price: new Decimal(d.price).toString(),
    stock,
    status,
  };
}

async function productJson(product: CatalogProduct): Promise<ProductJson> {
  const denominations = await Promise.all(product.denominations.map(denominationJson));
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    image: product.webImageUrl ?? productImage(product, product.category.name),
    category: categoryJson(product.category),
    denominations,
  };
}

/** clamp 1-99, default 1 — mirrors clampQty in ./cart, applied to a JSON qty. */
function clampJsonQty(raw: unknown): number {
  if (raw == null) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(n, 99));
}

/** Longest address RFC 5321 allows on the wire — anything past it is junk, and
 * checking it before the shape regex keeps a pathological input cheap. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately permissive shape check: one `@`, a dot-bearing domain, no
 * whitespace. The address is a contact/tracking handle, never an auth factor,
 * so the cost of wrongly rejecting a legitimate exotic address is higher than
 * the cost of accepting a syntactically odd one.
 */
const GUEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn an anonymous POST /checkout into a real (guest) `User` + session, or
 * send the failure response and return null. Split out of the route so the
 * order in which the cheap validations run is visible in one place: EVERY
 * check that can reject the request without touching the database happens
 * before `createGuestUser`, so a malformed or throttled request never leaves
 * an orphan user row behind.
 *
 * Payment-method tokens are NOT re-validated here beyond rejecting the wallet
 * ones — performCheckout owns that list and throws `web.pay_method_unavailable`
 * itself. The accepted consequence is that a request naming a gateway that
 * happens to be switched off creates one guest user row and then fails; the
 * per-IP rate limit bounds how many of those an abuser can make.
 */
async function establishGuestCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const body = req.body as { method?: string; guest_email?: string } | undefined;

  // (a) Contact email. NOT cross-checked against registered accounts on
  // purpose: rejecting an address because someone already signed up with it
  // would turn this endpoint into an account-existence oracle. A guest row
  // keeps `User.email` null and stores the address in `guestEmail`, so it can
  // never collide with the unique index on a registered account's email.
  const email = (body?.guest_email ?? "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !GUEST_EMAIL_RE.test(email)) {
    void reply.code(400).send({ error: "web.guest_email_invalid" });
    return null;
  }

  // (b) Balance payment methods need a wallet, and a guest has none.
  const method = (body?.method ?? "").toLowerCase();
  if (method === "wallet_idr" || method === "wallet_usdt") {
    void reply.code(400).send({ error: "web.pay_method_unavailable" });
    return null;
  }

  // (c) There has to be something to buy. Resolving the cookie lines against
  // the catalog (rather than just counting cookie entries) means a cart made
  // up entirely of deactivated SKUs is rejected here too, instead of after a
  // user row has already been written.
  const guestCart = await loadGuestCartItems(req);
  if (guestCart.length === 0) {
    void reply.code(400).send({ error: "error.cart_empty" });
    return null;
  }

  // (d) Per-IP throttle. Guest checkout mints a fresh user per order, so the
  // per-user MAX_PENDING_ORDERS cap in performCheckout can never bite for a
  // guest — this is the only thing standing between an abuser and unbounded
  // user/order rows plus tied-up stock reservations.
  if (guestCheckoutRateLimited(clientIp(req))) {
    void reply.code(429).send({ error: "error.rate_limited" });
    return null;
  }

  // (e)+(f) Write the row, then issue the session — which also migrates the
  // cookie cart into CartItem rows owned by the new user (performCheckout
  // reads the cart from the database) and clears the cookie.
  const guestUser = await createGuestUser(prisma, { email });
  const session = await establishSession(req, reply, { id: guestUser.id, telegramId: guestUser.telegramId });

  // Intentional: the buyer holds a session from this point on. If
  // performCheckout then fails (out of stock, gateway down) and they retry,
  // the retry takes the SIGNED-IN branch above and reuses this same guest
  // row — so `guestEmail` stays attached and the eventual order remains
  // trackable — BUT ONLY once the retry actually presents THIS session's
  // CSRF token. The SPA reads its token from the shell's
  // `<meta name="csrf-token">`, which routes/spaShell.ts renders empty for
  // the anonymous page load that made this very request — so without help
  // the browser would be holding a valid session cookie with no way to prove
  // it, and the retry (or a cancel) would 403 forever. That's why the route
  // below hands this session's `csrf` back as `csrf_token` on the 201 AND on
  // every guest 4xx raised after this point (fix pass 1, review finding I-1)
  // — the SPA adopts it immediately, and the "retry takes the signed-in
  // branch" property above actually holds in practice.
  return { ...session, user: guestUser };
}

/**
 * Attaches `csrf_token` to a guest response body — the freshly minted
 * session's CSRF token (fix pass 1, review finding I-1) — and leaves a
 * signed-in caller's body untouched. Signed-in callers already hold their
 * token from login/register, so adding it there would just be a new key the
 * SPA never asked for; the checked-in test for the signed-in 201 asserts the
 * body is EXACTLY `{ order_code, pay_url }`.
 */
function withGuestCsrf<T extends object>(body: T, isGuest: boolean, customer: Customer): T & { csrf_token?: string } {
  return isGuest ? { ...body, csrf_token: customer.csrf } : body;
}

/**
 * How long the guest's `201` will wait on SMTP before giving up on the mail.
 *
 * The send IS awaited (see sendGuestOrderCodeEmail) — but nodemailer's own
 * connection/greeting timeouts run into minutes, and by this point the order
 * exists and the buyer is staring at a spinner on a page they are about to pay
 * from. Past this cap we stop waiting, answer `email_sent: false`, and let the
 * original send finish (or fail) in the background with its rejection already
 * handled. Under-promising is safe here; making the buyer wait is not.
 */
const GUEST_ORDER_EMAIL_TIMEOUT_MS = 8_000;

/**
 * Mail a guest their order code, and report whether it actually went out.
 *
 * WHY THIS EXISTS: a guest's only two ways back into a paid order are the
 * 30-day session cookie and `POST /api/v1/track` (order code + email). The code
 * used to live on screen and nowhere else, so closing the tab and then losing
 * the cookie — new device, private window, a browser clean-up — lost the order
 * permanently. This is the durable second copy.
 *
 * WHY IT IS AWAITED: the `201` body carries `email_sent`, and the SPA only
 * promises an email when that flag is true (SMTP is optional per deployment).
 * A fire-and-forget send could only ever report "we tried", which is exactly
 * the dishonest copy this feature was written to avoid. Awaiting is bounded by
 * GUEST_ORDER_EMAIL_TIMEOUT_MS above, and EVERY failure below resolves to
 * `false` — this function never throws, so the order can never fail because of
 * mail.
 *
 * WHAT IT MAY CONTAIN: the order code and links, nothing else. Delivered
 * product content and credentials NEVER go in here — email is unencrypted and
 * sits in an inbox forever; the buyer reads what they bought on the order page.
 */
async function sendGuestOrderCodeEmail(req: FastifyRequest, to: string, orderCode: string): Promise<boolean> {
  try {
    const smtp = await getSmtpCreds(prisma);
    // SMTP isn't configured on this deployment — the feature is simply off, and
    // the SPA's copy falls back to pointing at the code on screen.
    if (!smtp) return false;

    const shopName = (await getSetting(prisma, "shop_name")) ?? "Toko Digital";
    const base = publicBase(req);
    const orderLink = `${base}/checkout/${orderCode}/pay`;
    const trackLink = `${base}/track`;

    // Bilingual in one body (English then Indonesian), same shape as the
    // password-reset mail in apiAuth.ts — the shop serves both languages and an
    // email has no session to read a language preference from.
    const text =
      `Your order code is:\n\n${orderCode}\n\n` +
      `Open your order:\n${orderLink}\n\n` +
      `Lost this browser, or on another device? Open it again with the code above and this email address:\n${trackLink}\n\n` +
      `Keep this email — the order code is the only way back into this order. What you bought is never sent by email; you read it on the order page.\n\n` +
      `--\n\n` +
      `Kode pesanan kamu:\n\n${orderCode}\n\n` +
      `Buka pesanan kamu:\n${orderLink}\n\n` +
      `Browser ini hilang, atau kamu pindah perangkat? Buka lagi pakai kode di atas dan alamat email ini:\n${trackLink}\n\n` +
      `Simpan email ini — kode pesanan adalah satu-satunya cara masuk kembali ke pesanan ini. Barang yang kamu beli tidak pernah dikirim lewat email; kamu membacanya di halaman pesanan.`;

    const send = sendMail(smtp, { to, subject: `${shopName} — order code ${orderCode}`, text });
    // Attached before the race so a rejection that lands AFTER the timeout is
    // already handled and can never surface as an unhandled rejection.
    const sent = send.then(
      () => true,
      (e: unknown) => {
        logger.error(
          { err: e, orderCode },
          "Failed to email a guest buyer the code for their new order. They have no signal to retry, so unless they saved the code from the order page they will not be able to reopen this order after their session cookie expires.",
        );
        return false;
      },
    );
    const timedOut = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), GUEST_ORDER_EMAIL_TIMEOUT_MS).unref?.();
    });
    return await Promise.race([sent, timedOut]);
  } catch (e) {
    // Reading the SMTP settings failed — the order is already paid for and must
    // not be held hostage by a settings read.
    logger.error(
      { err: e, orderCode },
      "Could not prepare the order-code email for a guest buyer, so none was sent. The order itself is unaffected, but the buyer has only the code shown on screen.",
    );
    return false;
  }
}

const apiRoutes: FastifyPluginAsync = async (app) => {
  // ---- 1. GET /categories ----
  app.get("/categories", async (_req, reply) => {
    const categories = await listActiveCategories(prisma);
    return reply.send({ categories: categories.map(categoryJson) });
  });

  // ---- 2. GET /categories/:slug/products ----
  app.get<{ Params: { slug: string } }>("/categories/:slug/products", async (req, reply) => {
    const category = await getCategoryBySlug(prisma, req.params.slug);
    if (!category || !category.isActive) {
      return reply.code(404).send({ error: "not_found" });
    }
    const products = await listCatalogProducts(prisma, category.id);
    return reply.send({ products: await Promise.all(products.map(productJson)) });
  });

  // ---- 3. GET /products ----
  app.get("/products", async (_req, reply) => {
    const products = await listCatalogProducts(prisma);
    return reply.send({ products: await Promise.all(products.map(productJson)) });
  });

  // ---- 4. GET /products/:slug ----
  app.get<{ Params: { slug: string } }>("/products/:slug", async (req, reply) => {
    const product = await getCatalogProductBySlugWithDenominations(prisma, req.params.slug);
    if (!product || !product.isActive || product.isArchived || product.denominations.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ product: await productJson(product) });
  });

  // ---- 5. GET /products/:slug/denominations ----
  app.get<{ Params: { slug: string } }>("/products/:slug/denominations", async (req, reply) => {
    const product = await getCatalogProductBySlugWithDenominations(prisma, req.params.slug);
    if (!product || !product.isActive || product.isArchived || product.denominations.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ denominations: await Promise.all(product.denominations.map(denominationJson)) });
  });

  // ---- 6. POST /cart ----
  app.post<{ Body: { denomination_id?: number; qty?: number } }>("/cart", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (customer) {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !constantTimeEqual(token, customer.csrf)) {
        return reply.code(403).send({ error: "csrf_failed" });
      }
    }

    const denominationId = Number(req.body?.denomination_id);
    if (!Number.isInteger(denominationId) || denominationId <= 0) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const denom = await getDenomination(prisma, denominationId);
    if (!denom || !denom.isActive) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const qty = clampJsonQty(req.body?.qty);

    // Cart guard (Task 6 design decision): a cart containing any manual /
    // manual_with_info line may contain EXACTLY that one line (any quantity)
    // — no other lines, same-SKU or different-SKU, auto or otherwise. This is
    // stricter than "auto vs manual" alone because Order.customerData assumes
    // one denomination's field spec applies to the whole order (the bot only
    // ever orders one denomination at a time) — the storefront's cart can
    // hold multiple products, which would break that assumption if two
    // different manual_with_info SKUs landed in the same order. Re-adding the
    // SAME denomination that's already the cart's one line (qty increment,
    // handled below by addToCart's upsert / the guest merge branch) is not a
    // new line, so it's exempt.
    const existingLines = await loadCartLines(req, customer);
    if (existingLines.length > 0) {
      const isSameSingleLine = existingLines.length === 1 && existingLines[0]!.denomination_id === denom.id;
      const mixedDelivery =
        denom.deliveryType !== DeliveryType.AUTO || existingLines.some((l) => l.delivery_type !== DeliveryType.AUTO);
      if (mixedDelivery && !isSameSingleLine) {
        return reply.code(400).send({ error: "error.cart_mixed_delivery" });
      }
    }

    if (customer) {
      await addToCart(prisma, customer.userId, denom.id, qty);
    } else {
      const lines = readGuestCart(req);
      const existing = lines.find((l) => l.p === denom.id);
      const next: GuestCartLine[] = existing
        ? lines.map((l) => (l.p === denom.id ? { p: l.p, q: Math.min(l.q + qty, 99) } : l))
        : [...lines, { p: denom.id, q: qty }];
      writeGuestCart(reply, next);
      // loadCartLines() re-reads the guest cookie from req.cookies — patch the
      // in-memory request cookie so it reflects the write we just made via
      // `reply`, instead of re-parsing the stale value from the incoming request.
      req.cookies[CART_COOKIE] = JSON.stringify({ v: CART_COOKIE_VERSION, items: next });
    }

    const items = await loadCartLines(req, customer);
    const subtotal = items.reduce((s, l) => s.plus(l.line_total), new Decimal(0));
    return reply.send({ items, subtotal: subtotal.toString() });
  });

  // ---- 7. POST /checkout ----
  app.post<{
    Body: {
      method?: string;
      voucher_code?: string;
      customer_data?: unknown;
      /** Guest checkout only — the contact address the order is tracked by.
       * Ignored entirely for a signed-in buyer. */
      guest_email?: string;
    };
  }>("/checkout", async (req, reply) => {
    const signedIn = await optionalCustomer(req);
    if (signedIn) {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !constantTimeEqual(token, signedIn.csrf)) {
        return reply.code(403).send({ error: "csrf_failed" });
      }
    }
    // Guest checkout (Task 4): an anonymous buyer is turned into a real
    // `User` + session here, then falls through to the SAME performCheckout /
    // ValidationError / 201 tail as a signed-in buyer below. Everything cheap
    // is validated BEFORE the user row is written, so a junk request never
    // leaves an orphan row behind. Guests are not CSRF-checked above for the
    // same reason the guest cart isn't (routes/cart.ts `csrfOk`): they have
    // no session to ride, and the cart cookie is SameSite=Lax.
    //
    // Minor (fix pass 1 review finding): `optionalCustomer` returns null for
    // a BANNED account's cookie, same as it does for no session at all — so a
    // banned user's request falls through to this guest branch and gets a
    // fresh guest checkout instead of a 401. That's inherent to offering
    // guest checkout at all (anyone anonymous can already reach this branch);
    // noted here so it isn't surprising to the next reader, not treated as a
    // new hole opened by the banned check.
    const customer = signedIn ?? (await establishGuestCustomer(req, reply));
    if (!customer) return; // the guest branch already sent its 4xx/429
    // True only when `customer` came from establishGuestCustomer above — used
    // to decide whether the response needs to carry the freshly minted
    // session's CSRF token (fix pass 1, review finding I-1: see the
    // "Intentional" comment in establishGuestCustomer for why).
    const isGuest = !signedIn;

    const method = (req.body?.method ?? "").toLowerCase();
    const voucherCode = (req.body?.voucher_code ?? "").trim().toUpperCase() || null;

    // Wallet credit as a payment method — no gateway, settles synchronously.
    // Separate method tokens from the gateway ones below; performCheckout
    // is untouched by this branch.
    if (method === "wallet_idr" || method === "wallet_usdt") {
      try {
        const { orderCode } = await performWalletCheckout(
          customer,
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
      const { orderCode } = await performCheckout(customer, method, voucherCode, req.body?.customer_data);

      // Mail the recovery code to guests only — a registered buyer has an
      // account and a "My orders" page, so mailing them would be a behaviour
      // change outside this feature.
      //
      // Keyed on the BUYER'S ROW (`user.isGuest`), not on `isGuest` above.
      // `isGuest` means "this request minted the session", which is the right
      // question for the CSRF handoff but the wrong one here: the retry after a
      // guest checkout that failed mid-flight arrives WITH the session the
      // failed attempt minted, so it takes the signed-in branch — and that
      // shopper, who has no account and no password, is precisely the one this
      // email exists for. `setLoginCredentials` clears `isGuest`/`guestEmail`
      // the moment a guest upgrades to a real account, so an upgraded row
      // correctly stops receiving it.
      const guestEmail = customer.user.isGuest ? customer.user.guestEmail : null;
      const emailSent = guestEmail ? await sendGuestOrderCodeEmail(req, guestEmail, orderCode) : false;

      const body = { order_code: orderCode, pay_url: `/checkout/${orderCode}/pay` };
      // `email_sent` is added for guests only: the checked-in test for the
      // signed-in 201 asserts that body is EXACTLY `{ order_code, pay_url }`,
      // and a registered buyer has no use for a flag about mail they never get.
      return reply.code(201).send(withGuestCsrf(guestEmail ? { ...body, email_sent: emailSent } : body, isGuest, customer));
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(400).send(withGuestCsrf({ error: e.key }, isGuest, customer));
      }
      throw e;
    }
  });
};

export default apiRoutes;
