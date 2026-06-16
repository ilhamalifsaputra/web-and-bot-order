# Cross-Front Payment Methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tambah **Bybit (USDT-BSC)** sebagai opsi bayar di storefront dan **QRIS (Rupiah/TokoPay)** di bot, memakai primitive pembayaran yang sudah ada; pindahkan klien TokoPay ke rumah bersama agar bot & storefront memakainya.

**Architecture:** Relokasi klien TokoPay (`createTransaction`/`verifyCallback`/tipe) ke `@app/core/payments/tokopay` + resolver `getTokopayCreds` ke `@app/db` (pola `resolveBybitConfig`). Storefront menambah opsi Bybit lewat `finalizeOrderPayment({currency:USDT, method:BYBIT})` (poller Bybit yang ada auto-confirm). Bot menambah `buyNowTokopay` → order IDR/TOKOPAY → QR foto di Telegram → webhook TokoPay yang ada deliver. Tampilkan kredensial di detail order bot agar pembeli QRIS Telegram bisa mengambilnya.

**Tech Stack:** TypeScript (ESM), pnpm workspaces, Prisma/SQLite (`@app/db`), Fastify+Nunjucks (storefront), grammY (bot), Vitest. Acuan spec: [`docs/superpowers/specs/2026-06-15-cross-front-payment-methods-design.md`](../specs/2026-06-15-cross-front-payment-methods-design.md).

---

## File Structure

**Dibuat:**
- `packages/core/src/payments/tokopay.ts` — klien TokoPay murni (HTTP+crypto): `createTransaction`, `verifyCallback`, tipe, konstanta kunci. Tanpa dependensi `@app/db`.
- `packages/core/src/payments/tokopay.test.ts` — unit test `verifyCallback` (pindahan, jika ada) + sanity.

**Dimodifikasi:**
- `packages/core/package.json` — tambah subpath export `./payments/tokopay`.
- `packages/db/src/crud/tokopay.ts` — tambah `getTokopayCreds` + re-ekspor kunci; perbarui komentar lokasi klien.
- `apps/storefront/src/routes/checkout.ts` — import dari rumah baru; token metode `binance|bybit|qris`; pembuatan order Bybit; cabang pay-page Bybit.
- `apps/storefront/views/checkout.njk` — 3 opsi radio metode.
- `apps/storefront/views/pay.njk` — cabang instruksi Bybit.
- `apps/storefront/test/storefront.test.ts` — test opsi Bybit.
- `apps/order-bot/src/handlers/checkout.ts` — `buyNowTokopay` + teruskan `tokopayEnabled` ke confirm keyboard.
- `apps/order-bot/src/keyboards/customer.ts` — param `tokopayEnabled` + tombol QRIS di `orderConfirmKb`; `qrisWaitingKb` baru.
- `apps/order-bot/src/handlers/callbacks.ts` — route `payq` → `buyNowTokopay`.
- `apps/order-bot/src/handlers/customer.ts` — `viewOrder` menampilkan kredensial order DELIVERED.
- `apps/notifier/src/templates.ts` — wording `ORDER_DELIVERED_DM` ke "My Orders di bot".
- `packages/core/locales/{en,id}.json` — kunci i18n baru.
- `apps/storefront/src/payments/tokopay.ts` — **dihapus** (isi pindah).
- `DOCS.md` — §15/§16 metode bayar simetris + dependensi callback URL.

**Hapus:**
- `apps/storefront/src/payments/tokopay.ts` (setelah relokasi; hanya `routes/checkout.ts` yang mengimpornya).

---

## Task 1: Relokasi klien TokoPay → `@app/core` + `getTokopayCreds` → `@app/db`

Relokasi murni — perilaku identik, suite TokoPay storefront harus tetap hijau.

**Files:**
- Create: `packages/core/src/payments/tokopay.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/db/src/crud/tokopay.ts`
- Modify: `apps/storefront/src/routes/checkout.ts:21-44`
- Delete: `apps/storefront/src/payments/tokopay.ts`

- [ ] **Step 1: Konfirmasi importir lama (peta kerja)**

Run: `grep -rn "payments/tokopay" apps packages --include=*.ts`
Expected: hanya `apps/storefront/src/routes/checkout.ts` yang **mengimpor** (`from "../payments/tokopay"`); kemunculan lain di `packages/db/src/crud/tokopay.ts` hanya **komentar**. Tidak ada test yang mengimpor modul itu langsung.

- [ ] **Step 2: Buat klien bersama di `@app/core`**

Create `packages/core/src/payments/tokopay.ts` (pindahkan bagian HTTP/crypto dari `apps/storefront/src/payments/tokopay.ts`; HILANGKAN `getTokopayCreds` dan import `@app/db`):

```ts
/**
 * TokoPay gateway client (HTTP + signature) — shared by the storefront pay page,
 * its webhook route, and the bot's QRIS checkout. Pure: no @app/db dependency
 * (credential resolution lives in @app/db `getTokopayCreds`). See DOCS.md §15.5.
 *
 * ⚠ ASSUMPTION (flagged): the endpoint shape + callback signature
 *   md5("merchantId:secret:refId") follow TokoPay's public docs. Verify against
 *   the live dashboard before go-live.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Decimal } from "../money";
import { logger } from "../logger";

export const TOKOPAY_MERCHANT_KEY = "tokopay_merchant_id";
export const TOKOPAY_SECRET_KEY = "tokopay_secret";
export const TOKOPAY_ENABLED_KEY = "tokopay_enabled";
export const TOKOPAY_CHANNEL_KEY = "tokopay_default_channel";

const API_BASE = process.env.TOKOPAY_API_BASE ?? "https://api.tokopay.id";

export interface TokopayCreds {
  merchantId: string;
  secret: string;
  channel: string;
}

export interface TokopayOrderInfo {
  trxId: string;
  payUrl: string | null;
  qrLink: string | null;
  qrString: string | null;
  totalBayar: string | null;
}

/** Create (or fetch — ref_id is idempotent) the gateway transaction for an order. */
export async function createTransaction(
  creds: TokopayCreds,
  args: { refId: string; amountIdr: Decimal.Value },
): Promise<TokopayOrderInfo> {
  const params = new URLSearchParams({
    merchant: creds.merchantId,
    secret: creds.secret,
    ref_id: args.refId,
    nominal: new Decimal(args.amountIdr).toFixed(0),
    metode: creds.channel,
  });
  const res = await fetch(`${API_BASE}/v1/order?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`TokoPay order HTTP ${res.status}`); // never log the query — it carries the secret
  }
  const body = (await res.json()) as {
    status?: unknown;
    data?: Record<string, unknown>;
    error_msg?: unknown;
  };
  const ok = String(body.status ?? "").toLowerCase() === "success" || body.status === 200;
  if (!ok || !body.data) {
    throw new Error(`TokoPay order rejected: ${String(body.error_msg ?? body.status ?? "unknown")}`);
  }
  const d = body.data;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const trxId = str(d.trx_id) ?? str(d.reference) ?? args.refId;
  return {
    trxId,
    payUrl: str(d.pay_url) ?? str(d.checkout_url),
    qrLink: str(d.qr_link),
    qrString: str(d.qr_string),
    totalBayar: d.total_bayar != null ? String(d.total_bayar) : null,
  };
}

export interface TokopayCallback {
  refId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
}

/** Verify a callback's signature + normalize. Returns null on bad/missing signature. */
export function verifyCallback(
  body: Record<string, unknown>,
  creds: Pick<TokopayCreds, "merchantId" | "secret">,
): TokopayCallback | null {
  const refId = firstString(body.ref_id, body.reff_id, body.reference);
  const signature = firstString(body.signature, body.sign);
  if (!refId || !signature) return null;

  const expected = createHash("md5")
    .update(`${creds.merchantId}:${creds.secret}:${refId}`)
    .digest("hex");
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    logger.warn(`TokoPay callback signature mismatch for ref ${refId}`);
    return null;
  }

  const amountRaw = firstString(body.nominal, body.amount, body.total_bayar) ?? "0";
  let amount: Decimal;
  try {
    amount = new Decimal(amountRaw);
  } catch {
    amount = new Decimal(0);
  }
  const status = (firstString(body.status) ?? "").toLowerCase();
  return {
    refId,
    trxId: firstString(body.trx_id, body.reference) ?? refId,
    amount,
    paid: ["success", "completed", "paid", "settlement"].includes(status),
  };
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 3: Daftarkan subpath export di `@app/core`**

Di `packages/core/package.json`, dalam `"exports"`, tambahkan setelah `"./mailer"` (baris 19):

```json
    "./mailer": "./src/mailer.ts",
    "./payments/tokopay": "./src/payments/tokopay.ts"
```

(pastikan koma JSON benar — `"./mailer"` kini diikuti koma).

- [ ] **Step 4: Tambah `getTokopayCreds` ke `@app/db`**

Di `packages/db/src/crud/tokopay.ts`, tambahkan import di atas dan fungsi resolver. Tambah ke blok import `@app/core`:

```ts
import {
  TOKOPAY_MERCHANT_KEY,
  TOKOPAY_SECRET_KEY,
  TOKOPAY_ENABLED_KEY,
  TOKOPAY_CHANNEL_KEY,
  type TokopayCreds,
} from "@app/core/payments/tokopay";
import { getSetting } from "./settings";
```

Lalu tambahkan (mis. setelah blok import, sebelum `deliverPaidTokopayOrder`):

```ts
/** Read TokoPay gateway credentials from Settings; null = the IDR/QRIS path is off. */
export async function getTokopayCreds(db: Db): Promise<TokopayCreds | null> {
  const [merchantId, secret, enabled, channel] = await Promise.all([
    getSetting(db, TOKOPAY_MERCHANT_KEY),
    getSetting(db, TOKOPAY_SECRET_KEY),
    getSetting(db, TOKOPAY_ENABLED_KEY),
    getSetting(db, TOKOPAY_CHANNEL_KEY),
  ]);
  if (!merchantId || !secret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { merchantId, secret, channel: (channel ?? "QRIS").trim() || "QRIS" };
}
```

> `Db` sudah diimpor di file ini (lihat bagian atas). Bila `getSetting` belum
> diimpor, tambahkan seperti di atas. `getTokopayCreds` otomatis terekspor lewat
> `export * from "./crud/tokopay"` di `packages/db/src/index.ts`.

Perbarui komentar lokasi (baris ~9) dari `apps/storefront/src/payments/tokopay.ts` → `packages/core/src/payments/tokopay.ts`.

- [ ] **Step 5: Alihkan import storefront**

Di `apps/storefront/src/routes/checkout.ts`, ganti blok import `../payments/tokopay` (baris ~39-44):

```ts
import {
  getTokopayCreds,
  createTransaction,
  verifyCallback,
  type TokopayOrderInfo,
} from "../payments/tokopay";
```

menjadi:

```ts
import { createTransaction, verifyCallback, type TokopayOrderInfo } from "@app/core/payments/tokopay";
```

dan tambahkan `getTokopayCreds` ke blok import `@app/db` yang sudah ada (baris 21-37):

```ts
  getSetting,
  getTokopayCreds,
} from "@app/db";
```

- [ ] **Step 6: Hapus modul storefront lama**

```bash
rm apps/storefront/src/payments/tokopay.ts
```

- [ ] **Step 7: Typecheck + test (relokasi murni → semua hijau)**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS — perilaku identik; test TokoPay storefront yang ada tetap lulus (mengimpor lewat rumah baru secara tidak langsung).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/payments/tokopay.ts packages/core/package.json packages/db/src/crud/tokopay.ts apps/storefront/src/routes/checkout.ts
git rm apps/storefront/src/payments/tokopay.ts
git commit -m "refactor(payments): share TokoPay client via @app/core + getTokopayCreds in @app/db"
```

---

## Task 2: Storefront — opsi Bybit di checkout (token metode + pembuatan order)

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (`checkoutView`, `POST /checkout`)
- Modify: `apps/storefront/views/checkout.njk`
- Modify: `packages/core/locales/{en,id}.json`
- Test: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `apps/storefront/test/storefront.test.ts`. File ini sudah punya `loginAs(identifier, password)` dan `csrfFrom(html)`. Reuse helper login + add-to-cart dari test checkout yang ADA di file ini (cari test yang `POST /checkout` — tiru langkah login → isi cart → `GET /checkout` untuk membaca CSRF → `POST /checkout`). Bybit di-enable via Settings.

```ts
describe("checkout — Bybit option", () => {
  async function enableBybit() {
    await setSetting(prisma, "bybit_deposit_address", "0xDEADBEEF00000000000000000000000000000000");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }
  // helper that mirrors the existing checkout test: returns { cookie, csrf } with a non-empty cart
  async function checkoutSession() {
    const cookie = await loginAs(BUYER_LOGIN, BUYER_PASSWORD); // reuse the test buyer constants in this file
    await addItemToCart(cookie); // reuse the existing cart helper used by other checkout tests
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("creates a BYBIT/USDT order when method=bybit and Bybit is enabled", async () => {
    await enableBybit();
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST", url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit", csrf_token: csrf }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    const code = res.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const order = await getOrderByCode(prisma, code);
    expect(order!.paymentMethod).toBe("BYBIT");
    expect(order!.currency).toBe("USDT");
  });

  it("rejects method=bybit when Bybit is disabled", async () => {
    const { cookie, csrf } = await checkoutSession(); // Bybit NOT enabled here
    const res = await app.inject({
      method: "POST", url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
  });
});
```

> `addItemToCart`, `BUYER_LOGIN`, `BUYER_PASSWORD` adalah nama placeholder untuk
> helper/konstanta yang SUDAH ada di `storefront.test.ts` — ganti dengan yang
> nyata (lihat test checkout yang ada). Tambah `getOrderByCode` ke import `@app/db`.

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/storefront test -- storefront.test.ts`
Expected: FAIL — `method=bybit` belum dikenali (order tak dibuat sebagai BYBIT / unavailable).

- [ ] **Step 3: Perbarui `checkoutView` (flag enable per metode)**

Di `apps/storefront/src/routes/checkout.ts`, di `checkoutView` (baris ~100-123) tambahkan `resolveBybitConfig` ke `Promise.all` dan hitung flag. Tambah import `resolveBybitConfig` ke blok `@app/db`:

```ts
  resolveBybitConfig,
```

Ubah `checkoutView` agar mengembalikan tiga flag metode (ganti `usdt_enabled`/`idr_enabled`):

```ts
  const [totals, fxRate, tokopay, bybit] = await Promise.all([
    computeTotals(customer, voucherCode),
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
  ]);
  const haveRate = Boolean(fxRate);
  return {
    items_empty: totals.empty,
    subtotal: totals.subtotal.toString(),
    bulk_discount: totals.bulkDiscount.toString(),
    voucher_discount: totals.voucherDiscount.toString(),
    total: totals.total.toString(),
    total_usdt: fxRate ? usdtFromIdr(totals.total, fxRate).toString() : null,
    voucher_code: voucherCode ?? "",
    error_key: errorKey ?? totals.voucherError,
    binance_enabled: haveRate && isBinanceInternalEnabled(),
    bybit_enabled: haveRate && bybit.enabled,
    idr_enabled: Boolean(tokopay),
  };
```

- [ ] **Step 4: Perbarui `POST /checkout` (token metode → currency+method)**

Ganti blok pemilihan metode + pembuatan order (baris ~169-211). Tambah import enum `PaymentMethod` (sudah diimpor di file). Logika baru:

```ts
      const customer = req.customer!;
      const method = (req.body.method ?? "").toLowerCase();
      const voucherCode = (req.body.voucher_code ?? "").trim().toUpperCase() || null;

      const rerender = async (errorKey: string) => {
        const ctx = await shopContext(req, "/cart");
        const view = await checkoutView(customer, voucherCode, errorKey);
        return reply.code(400).view("checkout.njk", { ...ctx, ...view });
      };

      const [fxRate, tokopay, bybit] = await Promise.all([
        getUsdIdrRate(prisma),
        getTokopayCreds(prisma),
        resolveBybitConfig(prisma),
      ]);

      // Map the chosen method token → (currency, paymentMethod), each gated.
      type Choice =
        | { currency: typeof OrderCurrency.USDT; rate: NonNullable<typeof fxRate>; method: PaymentMethod }
        | { currency: typeof OrderCurrency.IDR };
      let choice: Choice;
      if (method === "binance") {
        if (!fxRate || !isBinanceInternalEnabled()) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BINANCE_INTERNAL };
      } else if (method === "bybit") {
        if (!fxRate || !bybit.enabled) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT };
      } else if (method === "qris") {
        if (!tokopay) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.IDR };
      } else {
        return rerender("web.pay_method_unavailable");
      }

      try {
        const order = await prisma.$transaction(async (tx) => {
          if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
            throw new ValidationError("error.too_many_pending");
          }
          const created = await createOrderFromCart(tx, {
            user: {
              id: customer.userId,
              role: customer.user.role,
              walletBalance: customer.user.walletBalance,
            },
            voucherCode,
            walletAmount: 0,
          });
          if (!created) throw new ValidationError("error.generic");
          return finalizeOrderPayment(tx, created.id, choice);
        });
        return reply.code(303).redirect(`/checkout/${order!.orderCode}/pay`);
      } catch (e) {
        if (e instanceof ValidationError) return rerender(e.key);
        throw e;
      }
```

> `finalizeOrderPayment` menerima `{ currency: USDT, rate, method }` (lihat
> `createInternalOrder`/`createBybitOrder`) dan `{ currency: IDR }` (memaksa
> TOKOPAY). Tak perlu ubah crud.

- [ ] **Step 5: Tiga radio metode di `checkout.njk`**

Ganti blok metode (baris 21-41) `apps/storefront/views/checkout.njk`:

```njk
    <div class="card card-pad">
      <h2 class="section-title mb-3">{{ t('web.pay_method', lang) }}</h2>
      <div class="space-y-3">
        <label class="flex items-start gap-3 p-3 rounded-xl border {% if idr_enabled %}border-line hover:border-pine cursor-pointer{% else %}border-line opacity-50{% endif %}">
          <input type="radio" name="method" value="qris" class="mt-1" {% if not idr_enabled %}disabled{% else %}checked{% endif %}>
          <span>
            <span class="font-semibold text-sm block">{{ t('web.pay_idr_title', lang) }}</span>
            <span class="text-xs text-ink-soft block mt-0.5">{{ t('web.pay_idr_sub', lang) }}</span>
            {% if not idr_enabled %}<span class="text-xs text-rust block mt-0.5">{{ t('web.pay_idr_disabled', lang) }}</span>{% endif %}
          </span>
        </label>
        <label class="flex items-start gap-3 p-3 rounded-xl border {% if binance_enabled %}border-line hover:border-pine cursor-pointer{% else %}border-line opacity-50{% endif %}">
          <input type="radio" name="method" value="binance" class="mt-1" {% if not binance_enabled %}disabled{% elif not idr_enabled %}checked{% endif %}>
          <span>
            <span class="font-semibold text-sm block">{{ t('web.pay_usdt_title', lang) }}</span>
            <span class="text-xs text-ink-soft block mt-0.5">{{ t('web.pay_usdt_sub', lang) }}</span>
            {% if not binance_enabled %}<span class="text-xs text-rust block mt-0.5">{{ t('web.pay_usdt_disabled', lang) }}</span>{% endif %}
          </span>
        </label>
        <label class="flex items-start gap-3 p-3 rounded-xl border {% if bybit_enabled %}border-line hover:border-pine cursor-pointer{% else %}border-line opacity-50{% endif %}">
          <input type="radio" name="method" value="bybit" class="mt-1" {% if not bybit_enabled %}disabled{% endif %}>
          <span>
            <span class="font-semibold text-sm block">{{ t('web.pay_bybit_title', lang) }}</span>
            <span class="text-xs text-ink-soft block mt-0.5">{{ t('web.pay_bybit_sub', lang) }}</span>
            {% if not bybit_enabled %}<span class="text-xs text-rust block mt-0.5">{{ t('web.pay_bybit_disabled', lang) }}</span>{% endif %}
          </span>
        </label>
      </div>
    </div>
```

- [ ] **Step 6: Tambah kunci i18n**

Di `packages/core/locales/en.json` tambahkan (di grup `web.*`, sejajar `pay_usdt_title`):

```json
"web.pay_bybit_title": "Pay with USDT (Bybit / BSC)",
"web.pay_bybit_sub": "Send USDT on BNB Smart Chain to our Bybit deposit address. Auto-confirmed.",
"web.pay_bybit_disabled": "Bybit deposit is not configured yet.",
"web.pay_bybit_amount": "Send exactly this amount (USDT):",
"web.pay_bybit_address": "To this BEP20 (BSC) address:",
"web.pay_bybit_note": "Delivery is automatic once the deposit is credited — no proof needed."
```

Di `packages/core/locales/id.json` (kunci & placeholder identik):

```json
"web.pay_bybit_title": "Bayar USDT (Bybit / BSC)",
"web.pay_bybit_sub": "Kirim USDT di jaringan BNB Smart Chain ke alamat deposit Bybit kami. Otomatis terkonfirmasi.",
"web.pay_bybit_disabled": "Deposit Bybit belum dikonfigurasi.",
"web.pay_bybit_amount": "Kirim tepat sejumlah ini (USDT):",
"web.pay_bybit_address": "Ke alamat BEP20 (BSC) ini:",
"web.pay_bybit_note": "Pengiriman otomatis begitu deposit masuk — tanpa bukti."
```

- [ ] **Step 7: Jalankan test → lulus**

Run: `pnpm --filter @app/storefront test -- storefront.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/storefront/src/routes/checkout.ts apps/storefront/views/checkout.njk packages/core/locales/en.json packages/core/locales/id.json apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): offer Bybit (USDT-BSC) as a checkout method"
```

---

## Task 3: Storefront — halaman bayar cabang Bybit (alamat + jumlah)

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (`GET /checkout/:code/pay`)
- Modify: `apps/storefront/views/pay.njk`
- Test: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan:

```ts
it("pay page for a BYBIT order shows the deposit address + USDT amount", async () => {
  await setSetting(prisma, "bybit_deposit_address", "0xABCdef0000000000000000000000000000001234");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  // create a BYBIT order via POST /checkout method=bybit (reuse the helper above),
  // capture its code, then GET the pay page:
  const res = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("0xABCdef0000000000000000000000000000001234");
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/storefront test -- storefront.test.ts`
Expected: FAIL — pay page belum punya cabang Bybit (alamat tak muncul).

- [ ] **Step 3: Perbarui handler pay-page**

Di `apps/storefront/src/routes/checkout.ts`, `GET /checkout/:code/pay` (baris ~220-291). Saat ini menghitung `isUsdt` dan hanya membuat gateway TokoPay. Tambahkan cabang Bybit: ambil `resolveBybitConfig` untuk alamat dan teruskan flag metode ke template.

Ganti penentuan `isUsdt` + konteks `order` menjadi:

```ts
      const state = payState(order);
      const method = order.paymentMethod; // "BINANCE_INTERNAL" | "BYBIT" | "TOKOPAY" | ...
      const isBinance = method === PaymentMethod.BINANCE_INTERNAL;
      const isBybit = method === PaymentMethod.BYBIT;
      const isQris = method === PaymentMethod.TOKOPAY;

      // Bybit deposit address (no API call — just the configured address).
      const bybitAddress = isBybit ? (await resolveBybitConfig(prisma)).depositAddress : "";

      // TokoPay transaction (QR / pay link) only while actually payable + QRIS.
      let gateway: TokopayOrderInfo | null = null;
      let gatewayError = false;
      if (isQris && state === "waiting") {
        gateway = parseCachedGateway(order.paymentRef);
        if (!gateway) {
          const creds = await getTokopayCreds(prisma);
          if (creds) {
            try {
              gateway = await createTransaction(creds, {
                refId: order.orderCode,
                amountIdr: order.totalAmount,
              });
              await prisma.order.update({
                where: { id: order.id },
                data: { paymentRef: JSON.stringify(gateway) },
              });
            } catch (err) {
              logger.error({ err }, `TokoPay create failed for ${order.orderCode}`);
              gatewayError = true;
            }
          } else {
            gatewayError = true;
          }
        }
      }

      const waNumber = gatewayError && isQris
        ? ((await getSetting(prisma, "support_whatsapp")) ?? "").replace(/[^0-9]/g, "")
        : "";

      return reply.view("pay.njk", {
        ...ctx,
        order: {
          code: order.orderCode,
          status: order.status,
          currency: order.currency,
          total: order.totalAmount.toString(),
          payment_ref: order.paymentRef,
          expires_at_iso: order.expiresAt ? ensureUtc(order.expiresAt).toISO() : null,
        },
        state,
        is_binance: isBinance,
        is_bybit: isBybit,
        is_qris: isQris,
        bybit_address: bybitAddress,
        binance_uid: config.BINANCE_RECEIVE_UID ?? "",
        gateway,
        gateway_error: gatewayError,
        wa_number: waNumber,
        bot_username: botUsername() ?? "",
      });
```

> Hapus pemakaian `isUsdt` lama; `PaymentMethod` & `resolveBybitConfig` sudah
> diimpor (Task 2). `is_usdt` di template diganti `is_binance` (lihat Step 4).

- [ ] **Step 4: Cabang Bybit di `pay.njk`**

Di `apps/storefront/views/pay.njk`, ganti `{% if is_usdt %}` (baris 23) menjadi `{% if is_binance %}`, dan tambahkan cabang Bybit sebelum `{% else %}` TokoPay (baris 42). Struktur baru blok `{% if state == "waiting" %}` → `card`:

```njk
    {% if is_binance %}
    {# ---- Binance Internal Transfer (UID) — auto-confirm ---- #}
    <h2 class="section-title mb-3">{{ t('web.pay_usdt_title', lang) }}</h2>
    <ol class="text-sm text-ink-soft space-y-3 list-decimal pl-4">
      <li>{{ t('web.binance_step_open', lang) }}</li>
      <li>{{ t('web.binance_step_uid', lang) }}<div class="codeish !text-base mt-1 select-all">{{ binance_uid }}</div></li>
      <li>{{ t('web.binance_step_amount', lang) }}<div class="font-display font-semibold text-pine text-2xl mt-1">${{ order.total }}</div></li>
      <li>{{ t('web.binance_step_note', lang) }}<div class="codeish !text-base mt-1 select-all">{{ order.payment_ref }}</div></li>
    </ol>
    <p class="text-xs text-ink-faint mt-4">{{ t('web.binance_auto_note', lang) }}</p>
    {% elif is_bybit %}
    {# ---- Bybit USDT-BSC deposit — auto-confirm (amount match) ---- #}
    <h2 class="section-title mb-3">{{ t('web.pay_bybit_title', lang) }}</h2>
    <p class="text-sm text-ink-soft mt-2">{{ t('web.pay_bybit_amount', lang) }}</p>
    <div class="font-display font-semibold text-pine text-2xl mt-1">${{ order.total }}</div>
    <p class="text-sm text-ink-soft mt-3">{{ t('web.pay_bybit_address', lang) }}</p>
    <div class="codeish !text-base mt-1 select-all break-all">{{ bybit_address }}</div>
    <p class="text-xs text-ink-faint mt-4">{{ t('web.pay_bybit_note', lang) }}</p>
    {% else %}
    {# ---- TokoPay (QRIS) ---- #}
```

(biarkan sisa blok TokoPay apa adanya sampai `{% endif %}` di baris 85).

- [ ] **Step 5: Jalankan test → lulus**

Run: `pnpm --filter @app/storefront test -- storefront.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/storefront/src/routes/checkout.ts apps/storefront/views/pay.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): Bybit pay page shows deposit address + USDT amount"
```

---

## Task 4: Bot — opsi QRIS (TokoPay)

**Files:**
- Modify: `apps/order-bot/src/keyboards/customer.ts` (`orderConfirmKb` + `qrisWaitingKb`)
- Modify: `apps/order-bot/src/handlers/checkout.ts` (`buyNowTokopay`, teruskan `tokopayEnabled`)
- Modify: `apps/order-bot/src/handlers/callbacks.ts` (route `payq`)
- Modify: `packages/core/locales/{en,id}.json`
- Test: `apps/order-bot/test/*` (handler test; lihat pola test bot yang ada)

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan ke `apps/order-bot/test/handlers.test.ts` di dalam `describe("checkout handlers")` (mirror test `buyNow` yang ada di baris ~181). Harness: `makeCtx` (helper di `test/helpers/ctx.ts`) merekam panggilan ke `sink`; `calls(sink, "sendPhoto")` / `sentIncludes(sink, …)` memeriksanya; fixture `sample` (user/product/stock) sudah dipakai test lain. `createTransaction` di-mock di puncak file:

```ts
import { calls } from "./helpers/ctx"; // tambahkan `calls` ke import helper yang ada
vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "TP-TEST", payUrl: null, qrLink: "https://x/qr.png", qrString: "000", totalBayar: "100",
  }),
}));
```

```ts
  it("buyNowTokopay creates an IDR/TOKOPAY order and sends the QR photo", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    // mirror the existing buyNow test: makeCtx with session.dbUser = sample.user.
    const { ctx, sink } = makeCtx({ session: { dbUser: sample.user, lang: "en" } });
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id }, orderBy: { id: "desc" }, take: 1 });
    expect(orders[0]!.paymentMethod).toBe("TOKOPAY");
    expect(orders[0]!.currency).toBe("IDR");
    expect(calls(sink, "sendPhoto").length).toBe(1);
  });
```

> `vi` + `setSetting` + `sample` + `checkout` + `makeCtx` sudah dipakai/diimpor di
> `handlers.test.ts`; tambahkan hanya `calls` ke import `./helpers/ctx` dan blok
> `vi.mock` di puncak file. Konfirmasi bentuk `sample.user`/`sample.product`
> dengan test `buyNow` yang ada.

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/order-bot test`
Expected: FAIL — `buyNowTokopay` belum ada.

- [ ] **Step 3: `orderConfirmKb` + `qrisWaitingKb`**

Di `apps/order-bot/src/keyboards/customer.ts`, ubah signature `orderConfirmKb` (baris 332-339) untuk menerima `tokopayEnabled`:

```ts
export function orderConfirmKb(
  productId: number,
  qty: number,
  lang: string,
  voucherCode = "",
  internalEnabled = false,
  bybitEnabled = false,
  tokopayEnabled = false,
): InlineKeyboard {
```

dan di blok metode (setelah baris 355 `if (bybitEnabled) ...`), perluas kondisi pembungkus + tambah tombol QRIS:

```ts
  if (internalEnabled || bybitEnabled || tokopayEnabled) {
    rows.push([{ text: coreT("checkout.pay_binance_pay_btn", lang), data: cb("pay", productId, qty) }]);
    if (internalEnabled) rows.push([{ text: coreT("checkout.pay_internal_btn", lang), data: cb("payx", productId, qty) }]);
    if (bybitEnabled) rows.push([{ text: coreT("checkout.pay_bybit_btn", lang), data: cb("payb", productId, qty) }]);
    if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: cb("payq", productId, qty) }]);
  } else {
    rows.push([{ text: coreT("checkout.confirm_btn", lang), data: cb("pay", productId, qty) }]);
  }
```

Tambahkan keyboard tunggu-QRIS (Cancel-only, tanpa "Saya sudah bayar") setelah `paymentInstructionsKb`:

```ts
/** QRIS payment screen: auto-confirm via webhook, so only Cancel + Menu (no proof). */
export function qrisWaitingKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}
```

- [ ] **Step 4: Teruskan `tokopayEnabled` dari handler konfirmasi**

Di `apps/order-bot/src/handlers/checkout.ts`, di `showOrderConfirmation` (baris ~351-363) dan `renderOrderConfirmation` (baris ~375-387), hitung `tokopayEnabled` dan teruskan. Tambah import `getTokopayCreds` ke blok `@app/db`:

```ts
  getTokopayCreds,
```

Di kedua fungsi, sebelum memanggil `orderConfirmKb`, tambahkan:

```ts
  const tokopayEnabled = (await getTokopayCreds(prisma)) != null;
```

dan ubah argumen `orderConfirmKb(productId, quantity, lang, r.voucherCode, isBinanceInternalEnabled() && rate !== null, bybitEnabled && rate !== null)` menjadi:

```ts
    ckb.orderConfirmKb(productId, quantity, lang, r.voucherCode, isBinanceInternalEnabled() && rate !== null, bybitEnabled && rate !== null, tokopayEnabled),
```

(pada `showOrderConfirmation` argumen terakhir di `smartEdit`; pada `renderOrderConfirmation` di `reply_markup`).

- [ ] **Step 5: Handler `buyNowTokopay`**

Di `apps/order-bot/src/handlers/checkout.ts`, tambah import klien + creds:

```ts
import { createTransaction } from "@app/core/payments/tokopay";
```

(dan `getTokopayCreds` sudah ditambah di Step 4). Tambahkan handler setelah `buyNowBybit` (baris ~570):

```ts
/**
 * QRIS (TokoPay) — create an IDR order, draw the QR inside Telegram, and let the
 * existing TokoPay webhook auto-confirm. No proof upload. ⚠ Needs the public
 * callback URL configured (DOCS §15.5) or the order will stall then auto-cancel.
 */
export async function buyNowTokopay(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;

  const creds = await getTokopayCreds(prisma);
  if (!creds) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }
  const voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? null;
  delete ctx.session.scratch.appliedVoucherCode;

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }

  let order: Awaited<ReturnType<typeof createOrderDirect>>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode });
      if (!created) return created;
      return finalizeOrderPayment(tx, created.id, { currency: OrderCurrency.IDR });
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // Create (idempotent on ref_id) the gateway transaction + cache it.
  let gateway;
  try {
    gateway = await createTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: JSON.stringify(gateway) } });
  } catch (err) {
    logger.error({ err }, `TokoPay create failed for ${order.orderCode}`);
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.PAYMENT_WINDOW_MINUTES}m`;
  const caption = t(ctx, "checkout.qris_instructions", {
    code: order.orderCode,
    amount: formatIdr(order.totalAmount),
    expiry,
  });

  // Edit the confirm bubble into the QRIS caption, then send the QR image below.
  await smartEdit(ctx, caption, ckb.qrisWaitingKb(order.id, lang));
  ctx.session.qrMsgId = undefined;
  if (gateway.qrLink) {
    try {
      const qrMsg = await ctx.api.sendPhoto(chatId, gateway.qrLink);
      ctx.session.qrMsgId = qrMsg.message_id;
    } catch (err) {
      logger.error({ err }, "Failed to send QRIS photo");
    }
  }
  setActivePayment(chatId, order.id);
}
```

> `formatIdr`, `localize`, `getUser`, `createOrderDirect`, `finalizeOrderPayment`,
> `countUserPendingOrders`, `setActivePayment`, `OrderCurrency`, `config`,
> `logger`, `MAX_PENDING_ORDERS` semuanya sudah diimpor/terdefinisi di file ini.

- [ ] **Step 6: Route callback `payq`**

Di `apps/order-bot/src/handlers/callbacks.ts`, tambah dispatcher (setelah `dispatchPayBybit`, baris ~74):

```ts
const dispatchPayTokopay: DomainDispatcher = async (ctx, parts) => {
  // v1:payq:<pid>:<qty> → QRIS (TokoPay) order (auto-confirmed by webhook)
  await checkout.buyNowTokopay(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};
```

dan daftarkan di peta dispatcher (dekat baris 140 `payb: dispatchPayBybit,`):

```ts
  payq: dispatchPayTokopay,
```

- [ ] **Step 7: Kunci i18n bot**

Di `packages/core/locales/en.json`:

```json
"checkout.pay_qris_btn": "🇮🇩 Pay with QRIS (Rupiah)",
"checkout.qris_instructions": "🧾 <b>Order {code}</b>\nScan the QR below with any QRIS app (GoPay, OVO, DANA, bank).\n\n💵 Amount: <b>{amount}</b>\n⏳ Pay before: {expiry}\n\nDelivery is automatic once your payment is confirmed."
```

Di `packages/core/locales/id.json`:

```json
"checkout.pay_qris_btn": "🇮🇩 Bayar QRIS (Rupiah)",
"checkout.qris_instructions": "🧾 <b>Pesanan {code}</b>\nScan QR di bawah dengan aplikasi QRIS apa pun (GoPay, OVO, DANA, bank).\n\n💵 Jumlah: <b>{amount}</b>\n⏳ Bayar sebelum: {expiry}\n\nPengiriman otomatis begitu pembayaran terkonfirmasi."
```

- [ ] **Step 8: Jalankan test → lulus**

Run: `pnpm --filter @app/order-bot test`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/order-bot/src/keyboards/customer.ts apps/order-bot/src/handlers/checkout.ts apps/order-bot/src/handlers/callbacks.ts packages/core/locales/en.json packages/core/locales/id.json apps/order-bot/test
git commit -m "feat(bot): QRIS (TokoPay) checkout — in-Telegram QR, webhook auto-confirm"
```

---

## Task 5: Bot — kredensial di detail order + wording DM

Pembeli QRIS Telegram dikonfirmasi via webhook (bukan poller bot), jadi mereka
mengambil kredensial dari **My Orders di bot**.

**Files:**
- Modify: `apps/order-bot/src/handlers/customer.ts` (`viewOrder`)
- Modify: `apps/notifier/src/templates.ts` (`ORDER_DELIVERED_DM`)
- Modify: `packages/core/locales/{en,id}.json`
- Test: `apps/order-bot/test/*` (viewOrder credentials) + `apps/notifier/src/templates.test.ts`

- [ ] **Step 1: Tulis test yang gagal (detail order menampilkan kredensial)**

Tambahkan ke `apps/order-bot/test/handlers.test.ts` di `describe("customer handlers")` (mirror `viewOrder` test di baris ~153). Buat order milik `sample.user`, jadikan DELIVERED dengan stock SOLD ber-credentials (cara termudah: buat order lalu `approveOrder` — pola di test `approve` baris ~271 — atau seed langsung). `viewOrder` meng-edit bubble; assert lewat `sink` (`sentIncludes`).

```ts
  it("viewOrder shows credentials for a delivered order owned by the buyer", async () => {
    // Create + approve an order so it is DELIVERED with assigned stock credentials.
    const created = await prisma.$transaction((tx) =>
      createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    // move to PENDING_VERIFICATION then approve (mirrors the approve handler test setup)
    await prisma.order.update({ where: { id: created!.id }, data: { status: "PENDING_VERIFICATION" } });
    const { credentials } = await approveOrder(prisma, created!.id, { adminId: 0 });
    const { ctx, sink } = makeCtx({ session: { dbUser: sample.user, lang: "en" } });
    await viewOrder(ctx, created!.id);
    expect(sentIncludes(sink, credentials[0]!)).toBe(true);
  });
```

> `createOrderDirect`, `approveOrder` dari `@app/db` (tambahkan `approveOrder`
> ke import bila belum); `sentIncludes` dari `./helpers/ctx`. Sesuaikan transisi
> status dengan apa yang diterima `approveOrder` (PENDING_VERIFICATION).

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/order-bot test`
Expected: FAIL — `viewOrder` belum menampilkan kredensial.

- [ ] **Step 3: Tampilkan kredensial di `viewOrder`**

Di `apps/order-bot/src/handlers/customer.ts` `viewOrder` (baris ~490-527), pada cabang non-PENDING (`order.detail`), bila status DELIVERED rakit blok kredensial dari `order.items[].stockItem.credentials` dan sertakan. Tambahkan sebelum `text = t(ctx, "order.detail", {...})`:

```ts
    let credentialsBlock = "";
    if (order.status === OrderStatus.DELIVERED) {
      const groups: Array<[string, string[]]> = [];
      const idx = new Map<number, number>();
      for (const it of order.items) {
        if (!it.stockItem) continue;
        if (!idx.has(it.productId)) { idx.set(it.productId, groups.length); groups.push([it.product.name, []]); }
        groups[idx.get(it.productId)!]![1].push(it.stockItem.credentials);
      }
      if (groups.length) {
        const blocks = groups
          .map(([name, creds]) => `${esc(name)}\n<pre>${esc(creds.join("\n"))}</pre>`)
          .join("\n\n");
        credentialsBlock = `\n\n${t(ctx, "order.detail_credentials", { credentials: blocks })}`;
      }
    }
```

dan ubah penyusunan teks:

```ts
    text = t(ctx, "order.detail", {
      code: order.orderCode,
      status: statusBadge(order.status),
      total: orderAmount(order),
      created: ensureUtc(order.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'"),
      lines: itemLines.join("\n"),
    }) + credentialsBlock;
```

> `esc` sudah diimpor di file ini (dipakai untuk itemLines). `order.items[].stockItem`
> tersedia karena `getOrder` memakai `fullInclude`.

- [ ] **Step 4: Kunci i18n blok kredensial**

`packages/core/locales/en.json`:

```json
"order.detail_credentials": "🔑 <b>Your account(s):</b>\n{credentials}"
```

`packages/core/locales/id.json`:

```json
"order.detail_credentials": "🔑 <b>Akun kamu:</b>\n{credentials}"
```

- [ ] **Step 5: Wording `ORDER_DELIVERED_DM` → My Orders di bot**

Di `apps/notifier/src/templates.ts` (baris ~117-132), ubah teks agar menunjuk ke My Orders di bot (semua penerima DM ini punya telegramId — `deliverPaidTokopayOrder` hanya enqueue saat `telegramId != null`). Pertahankan tautan `order_url` web sebagai opsional:

```ts
  if (event === NotificationEvent.ORDER_DELIVERED_DM) {
    // Buyer DM after an order auto-delivers (TokoPay/QRIS path). Only enqueued for
    // buyers WITH a Telegram account, so we point them to the bot's My Orders.
    // Credentials are NEVER carried in the outbox payload.
    const code = escape(String(payload.order_code ?? ""));
    const rawUrl = typeof payload.order_url === "string" ? payload.order_url : "";
    const url = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
    const linkEn = url ? `\nOr view on the website: ${escape(url)}` : "";
    const linkId = url ? `\nAtau lihat di website: ${escape(url)}` : "";
    return (
      `✅ <b>Order <code>${code}</code> delivered!</b>\n` +
      `Payment confirmed — open <b>My Orders</b> in the bot to see your account(s).${linkEn}\n\n` +
      `✅ <b>Pesanan <code>${code}</code> terkirim!</b>\n` +
      `Pembayaran dikonfirmasi — buka <b>Pesananku</b> di bot untuk melihat akunmu.${linkId}`
    );
  }
```

- [ ] **Step 6: Sesuaikan test template notifier**

Di `apps/notifier/src/templates.test.ts`, perbarui ekspektasi `ORDER_DELIVERED_DM` agar mencocokkan wording baru (mis. `expect(text).toContain("My Orders")` / `"Pesananku"`).

- [ ] **Step 7: Jalankan test → lulus**

Run: `pnpm --filter @app/order-bot test && pnpm --filter @app/notifier test`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/order-bot/src/handlers/customer.ts apps/notifier/src/templates.ts apps/notifier/src/templates.test.ts packages/core/locales/en.json packages/core/locales/id.json apps/order-bot/test
git commit -m "feat(bot): show credentials in My Orders; point delivery DM to the bot"
```

---

## Task 6: Dokumentasi + verifikasi akhir

**Files:**
- Modify: `DOCS.md` (§15/§16)

- [ ] **Step 1: Perbarui DOCS.md**

Di §15/§16, catat metode bayar kini **simetris**: storefront = QRIS + Binance + **Bybit**; bot = Binance Pay + Internal + Bybit + **QRIS**. Tambahkan catatan: QRIS (web & bot) memerlukan **Callback URL TokoPay** publik (`https://<host>/pay/tokopay/callback`) agar auto-confirm; tanpa itu order QRIS mentok lalu auto-cancel.

- [ ] **Step 2: Paritas locale**

Run: `pnpm --filter @app/core test` (test paritas kunci `en.json`/`id.json` — pastikan kunci & placeholder identik).
Expected: PASS.

- [ ] **Step 3: Suite penuh hijau**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS semuanya.

- [ ] **Step 4: Commit**

```bash
git add DOCS.md
git commit -m "docs: symmetric payment methods (Bybit on web, QRIS in bot) + callback URL note"
```

---

## Catatan untuk eksekutor

- **Task 1 dulu & harus hijau** sebelum Task 2-5 — relokasi klien TokoPay adalah
  fondasi (storefront & bot mengimpor dari rumah baru). Karena relokasi murni,
  `pnpm test` wajib tetap hijau di Task 1.
- **Tanpa perubahan skema DB** — semua metode memakai enum `PaymentMethod` &
  tabel `ProcessedTokopayTx`/order yang sudah ada. Tak perlu `prisma db push`.
- **Jangan log rahasia** (CLAUDE.md): query `createTransaction` membawa `secret`
  → jangan log URL/query; kredensial tak masuk payload outbox/log.
- **Dependensi webhook QRIS (bot & web):** auto-confirm hanya jika Callback URL
  TokoPay publik diset (DOCS §15.5). Binance/Bybit (poller) tak terpengaruh.
- **i18n:** jaga set kunci `en.json` & `id.json` identik (placeholder sama) —
  ada test paritas yang akan gagal bila timpang.
- **Paritas pola:** Bybit di storefront meniru jalur Binance-Internal storefront;
  QRIS di bot meniru `buyNowBybit`. Ikuti pola yang ada, jangan buat util baru.
```
