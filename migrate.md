# MIGRATE.md — Migrasi Tiga Project Python → Node.js (TypeScript)

> Dokumen ini adalah rencana migrasi **lengkap dan detail** untuk memindahkan
> ketiga project dari stack Python ke **Node.js + TypeScript**, sambil menjaga
> *satu database bersama* dan pola arsitektur yang sudah ada (outbox, reserved
> stock, audit log, i18n EN/ID).
>
> Filosofi migrasi: **strangler-fig + shared DB**. Node ditulis untuk membaca
> skema SQLite yang persis sama, lalu tiap service dipindahkan satu per satu
> sambil yang lain tetap jalan di Python. Tidak ada perubahan skema saat cutover.

---

## 1. Ringkasan Eksekutif

| Aspek | Sekarang (Python) | Target (Node.js) |
|---|---|---|
| Bahasa | Python 3.12 | Node.js 20 LTS + TypeScript 5 |
| Bot framework | python-telegram-bot 21.6 (PTB) | **grammY** + plugin conversations/runner/sessions |
| Web admin | FastAPI + Jinja2 + HTMX | **Fastify** + **Nunjucks** + HTMX (tetap) |
| ORM | SQLAlchemy 2.0 async | **Prisma** (alternatif: Drizzle) |
| Migrasi DB | Alembic | Prisma Migrate |
| Validasi/Config | pydantic-settings | **zod** + dotenv |
| Decimal/uang | `decimal.Decimal` Numeric(12,4) | **decimal.js** (via Prisma `Decimal`) |
| Scheduler | APScheduler / PTB JobQueue | **croner** (timezone-aware) |
| i18n | JSON locale + loader | reuse JSON locale + `@grammyjs/i18n` / loader tipis |
| Auth web | itsdangerous + bcrypt | `@fastify/cookie` (signed) + `bcrypt` |
| Logging | stdlib logging + RotatingFileHandler | **pino** + `pino-roll` |
| Test | pytest + pytest-asyncio | **Vitest** + `light-my-request` |
| Packaging | tiga repo + `sys.path` hack | **monorepo pnpm workspaces** (paket `@app/*`) |
| Container | Docker / docker-compose | Docker (multi-stage Node) |

**Tiga service yang dimigrasi:**

1. **telegram-order-bot** — bot utama (long-polling, ±11.000 LOC). Sumber kebenaran skema DB.
2. **telegram-stock-web** — web admin (FastAPI, server-rendered, sudah selesai dibangun).
3. **telegram-testimoni-bot** — notifier yang menguras `notification_outbox` → channel publik.

Ketiganya berbagi **satu file SQLite** (`data/bot.db`, mode WAL) lewat outbox pattern.

---

## 2. Inventaris Stack Saat Ini (yang harus dipetakan 1:1)

### 2.1 order-bot (`bot/`)
- `config.py` — `pydantic-settings`, properti `admin_ids`, `is_admin()`, `data_dir`.
- `database/models.py` — **17 tabel** (lihat §5). Enum disimpan sebagai string (`native_enum=False`). Uang `Numeric(12,4)`.
- `database/session.py` — engine async global, `session_scope()` (commit/rollback otomatis), `init_db()` (create_all + PRAGMA WAL + migrasi legacy + Alembic).
- `database/crud.py` — **±1.900 LOC**, satu-satunya tempat query. Web & notifier mengimpor ini.
- `handlers/` — `admin.py` (2017), `customer.py` (1140), `checkout.py` (804), `verification.py` (472), `callbacks.py` (350), `support.py` (242), `static_pages.py` (57).
- `keyboards/` — `admin_kb.py` (532), `customer_kb.py` (476).
- `utils/` — `decorators.py` (rate-limit, `safe_handler`, `admin_only`), `i18n.py`, `validators.py` (`ValidationError` ber-key i18n), `jobs.py` (4 job), `formatters.py`, `chat.py`, `logger.py` (contextvar `update_id`).
- `messages.py` (815) — string builder.
- `locales/en.json`, `locales/id.json`.
- `main.py` — build PTB Application, daftar handler per-group, jadwalkan job, command menu per-bahasa & per-admin.

**Conversation handlers (FSM) yang WAJIB diport** (dari `main.py`):
`voucher_conv`, `proof_conv`, `support_conv`, `reject_conv`, `stock_upload_conv`,
`broadcast_conv`, `voucher_create_conv`, `user_search_conv`, `setting_conv`,
`product_create_conv`, `bulk_pricing_conv`, `product_edit_conv`,
`ticket_reply_conv`, `review_conv`, `ticket_user_reply_conv`.

**Background jobs (`utils/jobs.py`):**
| Job | Jadwal | Fungsi |
|---|---|---|
| `auto_cancel_expired_orders` | tiap 60 dtk (first 30s) | batalkan order lewat `expires_at`, lepas stok |
| `auto_close_stale_tickets` | tiap 1 jam (first 5m) | tutup tiket basi |
| `reconcile_finances_job` | tiap 6 jam (first 10m) | deteksi drift order/voucher/wallet → audit + DM admin |
| `send_warranty_reminders` | harian 09:00 `TIMEZONE` | ingatkan garansi mau habis |

### 2.2 stock-web (`app/`)
- FastAPI + Jinja2 (`Jinja2Templates`), HTMX, Tailwind CDN.
- `auth.py` — cookie ber-tanda `itsdangerous` `{u,t,j,c}` (user_id, telegram_id, jti, csrf), bcrypt hash di `settings` key `web_admin_password_hash:<tg>`, jti rotasi di `web_session_jti:<tg>`, rate-limit login.
- `deps.py` — `current_admin`, `csrf_protect`, filter Jinja `money`/`localdt`, `redirect_with_flash`, `render_error`.
- `routers/` — auth, dashboard, stock, orders, catalog, vouchers, users, support, settings, audit.
- `templates/` — 18 file (base + `_macros` + per-halaman).
- Mengimpor `bot.database.crud/models/session` via `sys.path` (lihat `app/__init__.py`).

### 2.3 testimoni-bot (`notif_bot/`)
- `config.py` — dataclass env (`NOTIF_BOT_TOKEN`, `PUBLIC_CHANNEL_ID`, interval, max attempts).
- `dispatcher.py` — loop polling: `fetch_pending_notifications` → render → `bot.send_message` → `mark_notification_sent/failed`. Tangani `RetryAfter`/`Forbidden`.
- `templates.py` — render payload outbox jadi pesan HTML, i18n via `payload.buyer_language` (EN/ID).
- `main.py` — load env sendiri + env bot utama, impor `bot.*` via `sys.path`.

---

## 3. Stack Target Node.js (pemetaan dependensi)

```jsonc
// Bersama (root / paket @app/core, @app/db)
"typescript": "^5.6",
"tsx": "^4.19",                 // run TS langsung saat dev
"zod": "^3.23",                 // ganti pydantic-settings (validasi env & input)
"dotenv": "^16.4",
"decimal.js": "^10.4",          // ganti Python Decimal (juga dipakai Prisma)
"pino": "^9.5", "pino-roll": "^3.0",  // ganti logging + RotatingFileHandler
"luxon": "^3.5",                // ganti pytz/zoneinfo (Asia/Jakarta, UTC)
"prisma": "^5.22", "@prisma/client": "^5.22",
"croner": "^8.1",               // ganti APScheduler/JobQueue

// Bot (paket apps/order-bot, apps/notifier)
"grammy": "^1.30",
"@grammyjs/conversations": "^1.2",   // ganti PTB ConversationHandler
"@grammyjs/runner": "^2.0",          // konkruensi update (sequentialize per-chat)
"@grammyjs/ratelimiter": "^1.2",     // ganti decorators rate-limit (opsional)

// Web (paket apps/web-admin)
"fastify": "^5.1",
"@fastify/view": "^10.0", "nunjucks": "^3.2",  // ganti Jinja2 (sintaks paling mirip)
"@fastify/static": "^8.0",
"@fastify/formbody": "^8.0",         // parse application/x-www-form-urlencoded
"@fastify/cookie": "^11.0",          // signed cookie → ganti itsdangerous
"@fastify/csrf-protection": "^7.0",  // opsional; kita bisa pertahankan pola csrf==session
"bcrypt": "^5.1",                    // sama persis dengan bcrypt Python

// Test
"vitest": "^2.1",
"@vitest/coverage-v8": "^2.1"
```

> **Catatan ORM:** Default rekomendasi **Prisma** (DX + migrate + introspeksi). Jika
> butuh kontrol SQL mentah/locking yang lebih halus (mis. `SELECT ... FOR UPDATE`
> di Postgres), **Drizzle ORM** adalah alternatif yang lebih dekat ke SQLAlchemy.
> §5.4 membahas konsekuensi concurrency.

---

## 4. Arsitektur Repo Target (monorepo pnpm)

Mirror dari pola "share `bot.*` lewat sys.path" → diganti **workspace packages** yang
diimpor sebagai `@app/db`, `@app/core`. Tidak ada lagi hack `sys.path`.

```
project-bot-order/                 (root workspace)
├─ package.json                    # "packageManager": "pnpm@9", workspaces
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .env                            # satu sumber env bersama (lihat §11)
├─ prisma/
│  ├─ schema.prisma                # SATU skema, dipakai semua service
│  └─ migrations/
├─ packages/
│  ├─ db/                          # @app/db  → PrismaClient singleton + repo/CRUD
│  │  ├─ src/client.ts             # ganti session.py (engine global + WAL pragma)
│  │  ├─ src/crud/                 # PORT crud.py — satu folder per domain
│  │  │  ├─ users.ts  orders.ts  stock.ts  catalog.ts
│  │  │  ├─ vouchers.ts support.ts  settings.ts  audit.ts
│  │  │  └─ notifications.ts       # outbox: enqueue/fetchPending/markSent/markFailed
│  │  └─ src/index.ts
│  └─ core/                        # @app/core → util lintas service
│     ├─ src/config.ts             # zod env schema (ganti config.py)
│     ├─ src/money.ts              # decimal.js helper (quantize 4dp, currency)
│     ├─ src/datetime.ts           # luxon: ensureUtc, localize(TIMEZONE)
│     ├─ src/i18n.ts               # loader locales/*.json
│     ├─ src/errors.ts             # AppError (ganti ValidationError + key i18n)
│     └─ src/logger.ts             # pino + AsyncLocalStorage(update_id)
├─ apps/
│  ├─ order-bot/                   # ganti telegram-order-bot/bot
│  │  ├─ src/main.ts               # build Bot, daftar middleware, runner, jobs
│  │  ├─ src/handlers/             # admin/ customer/ checkout/ verification/ support/ callbacks
│  │  ├─ src/conversations/        # 15 conversation (FSM) — lihat §7.3
│  │  ├─ src/keyboards/            # admin.ts customer.ts
│  │  ├─ src/jobs/                 # 4 job croner (§7.4)
│  │  ├─ src/messages.ts
│  │  └─ src/locales/{en,id}.json  # copy dari Python
│  ├─ web-admin/                   # ganti telegram-stock-web/app
│  │  ├─ src/server.ts             # ganti main.py (Fastify app)
│  │  ├─ src/auth.ts               # signed cookie + bcrypt + jti
│  │  ├─ src/plugins/              # csrf, currentAdmin, nunjucks filters
│  │  ├─ src/routes/               # 1 file per router (port langsung)
│  │  └─ views/                    # *.njk (port dari Jinja templates)
│  └─ notifier/                    # ganti telegram-testimoni-bot/notif_bot
│     ├─ src/main.ts
│     ├─ src/dispatcher.ts
│     └─ src/templates.ts          # render testimoni i18n
└─ tests/                          # vitest (bisa per-app juga)
```

**Aturan ketat (warisan dari WEB.md, tetap berlaku):**
- Semua akses DB lewat `@app/db` (repo/CRUD). **Tidak ada query mentah** tersebar.
- Web admin **tidak pernah** mengirim pesan Telegram (hanya catat + outbox).
- **Tidak pernah** mencatat kredensial stok, hash password, `file_id`, atau full `DATABASE_URL`.
- Edit `settings` web hanya whitelist key.
- Uang selalu `Decimal`, quantize 4 dp; timestamp simpan UTC, localize saat tampil.

---

## 5. Database & Skema Prisma (inti migrasi)

### 5.1 Strategi: introspeksi dulu, jangan ubah skema
DB sudah ada dan sedang dipakai produksi. Jangan biarkan Prisma membuat ulang.

```bash
# 1. Tunjuk Prisma ke DB existing
#    .env: DATABASE_URL="file:./data/bot.db"   (Prisma SQLite pakai file: URL)
# 2. Tarik skema dari DB yang sudah berjalan
pnpm prisma db pull
# 3. Generate client
pnpm prisma generate
# 4. Baseline migration (TANPA menjalankan apa-apa ke DB existing)
pnpm prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
pnpm prisma migrate resolve --applied 0_init
```

> **Penting — URL berbeda format:** SQLAlchemy `sqlite+aiosqlite:///data/bot.db`
> ≠ Prisma `file:./data/bot.db`. Selama masa transisi, simpan **dua** variabel:
> `DATABASE_URL` (Python) dan `DATABASE_URL_PRISMA` (Node), menunjuk file yang sama.

### 5.2 Pemetaan tipe SQLAlchemy → Prisma

| SQLAlchemy | Prisma (SQLite) | Catatan |
|---|---|---|
| `Integer` PK | `Int @id @default(autoincrement())` | |
| `BigInteger` (telegram_id) | `BigInt` | TS pakai `bigint`; hati-hati JSON serialize |
| `String(n)` / `Text` | `String` | SQLite tak punya panjang; validasi panjang di zod |
| `Numeric(12,4)` | `Decimal` | decimal.js; **quantize 4dp**; jangan Float |
| `Boolean` | `Boolean` | |
| `DateTime(timezone=True)` | `DateTime` | simpan UTC; localize via luxon di layer tampil |
| `Enum(..native_enum=False)` | `String` + union TS | **lihat §5.3** |
| `ForeignKey(..ondelete=)` | relation + `onDelete:` | SQLite butuh `PRAGMA foreign_keys=ON` |
| `UniqueConstraint` | `@@unique` | |
| `Index` | `@@index` | |

### 5.3 Enum: simpan tetap sebagai String (kompatibel byte-for-byte)
Karena Python pakai `native_enum=False`, nilai enum **sudah** tersimpan sebagai
string biasa (`"pending_verification"`, `"percent"`, dst). Di Prisma SQLite, enum
native tidak didukung penuh — jadi **pertahankan sebagai `String`** dan bungkus
dengan union/const TS + validasi zod. Ini menjamin kompatibilitas data 100%.

```ts
// packages/core/src/enums.ts
export const OrderStatus = {
  PENDING_PAYMENT: "pending_payment",
  PENDING_VERIFICATION: "pending_verification",
  PAID: "paid",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
  REFUNDED: "refunded",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const zOrderStatus = z.nativeEnum(OrderStatus); // validasi input
// Idem: UserRole, Language, ProductType, StockStatus, VoucherType,
//       TicketStatus, SenderType, NotificationEvent, NotificationStatus.
```

> Jika nanti pindah ke **Postgres**, baru pertimbangkan enum native + migrasi data.

### 5.4 Concurrency & "reserved stock" (paling kritis)
Python mengandalkan `with_for_update()` (row lock) untuk mencegah dua pembeli
mengambil stok yang sama. Di SQLite, **seluruh DB diserialisasi saat menulis**
(satu writer), jadi transaksi interaktif sudah memberi jaminan setara.

- **Prisma + SQLite:** bungkus alokasi stok & approve dalam *interactive transaction*:
  ```ts
  await prisma.$transaction(async (tx) => {
    const item = await tx.stockItem.findFirst({
      where: { productId, status: "available" },
      orderBy: { id: "asc" },
    });
    if (!item) throw new AppError("error.cannot_deliver_out_of_stock");
    await tx.stockItem.update({
      where: { id: item.id, status: "available" }, // guard: status belum berubah
      data: { status: "reserved", orderId, reservedAt: new Date() },
    });
    // ...buat order item, dst
  }, { isolationLevel: "Serializable", timeout: 10_000 });
  ```
  Tambahkan guard `where: { status: "available" }` pada `update` agar update-by-id
  gagal jika status sudah berubah (optimistic check), lalu retry.
- **Jika pindah Postgres:** gunakan `SELECT ... FOR UPDATE SKIP LOCKED` (lewat
  `prisma.$queryRaw` atau Drizzle) untuk alokasi stok paralel sungguhan.

### 5.5 Outbox pattern (harus tetap utuh)
`approve_order` menulis baris `notification_outbox` **dalam transaksi yang sama**
dengan flip status order. Port ke Prisma: panggil `enqueueNotification(tx, ...)`
di dalam blok `$transaction` yang sama. Payload tetap JSON string, field
`buyer_language` wajib ada (dipakai notifier untuk i18n).

### 5.6 PRAGMA / WAL
`session.py` set `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`.
Di Node, jalankan sekali saat init client:

```ts
// packages/db/src/client.ts
export const prisma = new PrismaClient();
export async function initDb() {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  await prisma.$executeRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$executeRawUnsafe("PRAGMA synchronous = NORMAL");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout = 5000"); // hindari SQLITE_BUSY
}
```

---

## 6. Paket Bersama `@app/core` & `@app/db`

### 6.1 Config (zod) — ganti `config.py`
```ts
// packages/core/src/config.ts
import { z } from "zod";
import "dotenv/config";

const Env = z.object({
  BOT_TOKEN: z.string().min(20),
  BOT_USERNAME: z.string().min(3),
  ADMIN_IDS: z.string().default("").transform(s =>
    s.split(",").map(x => x.trim()).filter(Boolean).map(Number)),
  SUPPORT_GROUP_ID: z.coerce.number().optional(),
  BINANCE_PAY_ID: z.string(),
  CURRENCY: z.string().default("USDT"),
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),
  USE_UNIQUE_CENTS: z.coerce.boolean().default(true),
  DATABASE_URL_PRISMA: z.string().default("file:./data/bot.db"),
  DEFAULT_LANGUAGE: z.enum(["en", "id"]).default("en"),
  REFERRAL_COMMISSION_PERCENT: z.coerce.number().default(10),
  DEFAULT_WARRANTY_DAYS: z.coerce.number().default(30),
  LOW_STOCK_THRESHOLD: z.coerce.number().default(3),
  TIMEZONE: z.string().default("Asia/Jakarta"),
  LOG_LEVEL: z.enum(["debug","info","warn","error"]).default("info"),
  // web-only
  WEB_COOKIE_SECRET: z.string().min(32).optional(),
  WEB_COOKIE_NAME: z.string().default("stockweb_session"),
  WEB_SESSION_TTL_HOURS: z.coerce.number().default(12),
  // notifier-only
  NOTIF_BOT_TOKEN: z.string().optional(),
  PUBLIC_CHANNEL_ID: z.coerce.number().optional(),
  NOTIF_POLL_INTERVAL_SECONDS: z.coerce.number().default(10),
  NOTIF_MAX_ATTEMPTS: z.coerce.number().default(5),
});

export const config = Env.parse(process.env);
export const isAdmin = (tg: number) => config.ADMIN_IDS.includes(tg);
```

### 6.2 Uang (decimal.js) — ganti Decimal Python
```ts
// packages/core/src/money.ts
import Decimal from "decimal.js";
const Q = new Decimal("0.0001");
export const money = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(4);
export const fmtMoney = (v: Decimal.Value | null) =>
  v == null ? "—" : new Decimal(v).toDecimalPlaces(4).toString();
```
> Prisma mengembalikan `Decimal` (instance decimal.js-light). Pastikan **tidak
> pernah** mengonversi ke `number` untuk aritmetika uang.

### 6.3 Tanggal (luxon) — ganti pytz/zoneinfo
```ts
// packages/core/src/datetime.ts
import { DateTime } from "luxon";
import { config } from "./config";
export const ensureUtc = (d: Date) => DateTime.fromJSDate(d, { zone: "utc" });
export const localize = (d: Date, fmt = "yyyy-LL-dd HH:mm") =>
  DateTime.fromJSDate(d, { zone: "utc" }).setZone(config.TIMEZONE).toFormat(fmt);
```

### 6.4 Error ber-key i18n — ganti `ValidationError`
```ts
// packages/core/src/errors.ts
export class AppError extends Error {
  constructor(public key: string, public formatArgs: Record<string, unknown> = {}) {
    super(key);
  }
}
// humanize() di web meniru humanize_validation_error(): ambil key + args.
```

### 6.5 Logging (pino + AsyncLocalStorage) — ganti contextvar `update_id`
```ts
// packages/core/src/logger.ts
import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
export const updateCtx = new AsyncLocalStorage<{ updateId?: number }>();
export const logger = pino({
  level: config.LOG_LEVEL,
  mixin: () => ({ updateId: updateCtx.getStore()?.updateId }),
  transport: { target: "pino-roll", options: {
    file: "data/logs/bot.log", size: "10m", limit: { count: 5 } } },
});
```
grammY middleware membungkus tiap update dengan `updateCtx.run({ updateId }, next)`
→ semua log dalam pemrosesan update itu ber-`updateId` (setara group -2 PTB).

### 6.6 CRUD → repo modules
`crud.py` (±1.900 LOC) diport per-domain ke `packages/db/src/crud/*.ts`. Pertahankan
**nama fungsi** semirip mungkin agar diff mudah ditinjau, mis.:
`approveOrder`, `rejectOrder`, `createOrderDirect`, `attachPaymentProof`,
`bulkAddStock`, `markStockDead`, `listOrders`, `countOrders`, `adjustWallet`,
`enqueueNotification`, `fetchPendingNotifications`, `markNotificationSent/Failed`,
`logAdminAction`, dst. Semua menerima `tx`/`prisma` sebagai argumen pertama
(setara `session`).

---

## 7. Migrasi order-bot (PTB → grammY)

### 7.1 Pemetaan konsep PTB → grammY
| PTB | grammY |
|---|---|
| `Application` | `Bot` |
| handler `group=N` (prioritas) | urutan `bot.use(...)` / `Composer` |
| `CommandHandler` | `bot.command("start", ...)` |
| `CallbackQueryHandler(pattern=r"^v1:")` | `bot.callbackQuery(/^v1:/, ...)` |
| `MessageHandler(filters.TEXT & ~COMMAND)` | `bot.on("message:text", ...)` (cek `!text.startsWith("/")`) |
| `ConversationHandler` (FSM) | `@grammyjs/conversations` |
| `context.user_data` | `@grammyjs/sessions` |
| `ContextTypes.DEFAULT_TYPE` | `MyContext` (flavor) |
| `Defaults(parse_mode=HTML)` | `bot.api.config.use(...)` / set per-reply `parse_mode:"HTML"` |
| `JobQueue` | **croner** (di luar bot, akses Bot API langsung) |
| `ApplicationHandlerStop` | `return` (hentikan rantai) / `await ctx.conversation.exit()` |
| `app.run_polling(allowed_updates=ALL, drop_pending=True)` | `run(bot)` dari `@grammyjs/runner` + `drop_pending_updates: true` |
| error handler `app.add_error_handler` | `bot.catch((err) => ...)` |
| `bind_update_id` (group -2) | middleware pertama `updateCtx.run(...)` |

### 7.2 Skeleton `main.ts`
```ts
import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { run, sequentialize } from "@grammyjs/runner";
import { config } from "@app/core/config";
import { initDb } from "@app/db";
import { updateCtx, logger } from "@app/core/logger";

const bot = new Bot<MyContext>(config.BOT_TOKEN);

bot.use(async (ctx, next) => updateCtx.run({ updateId: ctx.update.update_id }, next)); // group -2
bot.use(sequentialize((ctx) => String(ctx.chat?.id)));  // serialisasi per-chat (mirip block=True)
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// daftar 15 conversation
bot.use(createConversation(proofConversation, "proof"));
// ... dst

// commands (group 1)
bot.command(["start","menu"], startCommand);
bot.command("admin", adminCommand);
// callback router (group 2)
bot.callbackQuery(/^v1:/, routeCallback);
bot.on("message:text", handleProductNumber);

bot.catch((err) => logger.error({ err }, "Unhandled bot error"));

await initDb();
await setupCommandMenu(bot); // set_my_commands EN/ID + per-admin (post_init)
run(bot, { runner: { fetch: { allowed_updates: [], drop_pending_updates: true } } });
```

### 7.3 Conversations (FSM) — ganti `ConversationHandler`
Tiap `build_*_conv()` PTB → satu fungsi `async function xConversation(conv, ctx)`
pakai `@grammyjs/conversations`. Pola: `await conv.wait()` menggantikan
`return STATE_X`. Contoh proof-upload:
```ts
async function proofConversation(conv: MyConversation, ctx: MyContext) {
  await ctx.reply(t(ctx, "checkout.send_proof"));
  const photoCtx = await conv.waitFor("message:photo");
  const fileId = photoCtx.message.photo.at(-1)!.file_id;
  await ctx.reply(t(ctx, "checkout.send_txid"));
  const txCtx = await conv.waitFor("message:text");
  await conv.external(() => attachPaymentProof(prisma, orderId, {
    fileId, txid: txCtx.message.text }));
  await ctx.reply(t(ctx, "checkout.proof_received"));
}
```
> **Aturan emas conversations:** semua efek samping (DB, I/O, random) harus
> dibungkus `conv.external(...)` atau `conv.run`-safe, karena fungsi conversation
> di-*replay*. Ini bedanya paling besar dengan PTB; review tiap port dengan teliti.

**Daftar 15 conversation untuk diport** (checklist di §15).

### 7.4 Jobs (croner) — ganti JobQueue
```ts
// apps/order-bot/src/jobs/index.ts
import { Cron } from "croner";
export function scheduleJobs(bot: Bot) {
  new Cron("*/1 * * * *", () => autoCancelExpiredOrders(bot));        // tiap menit
  new Cron("0 * * * *", () => autoCloseStaleTickets(bot));           // tiap jam
  new Cron("0 */6 * * *", () => reconcileFinances(bot));             // tiap 6 jam
  new Cron("0 9 * * *", { timezone: config.TIMEZONE },
           () => sendWarrantyReminders(bot));                        // 09:00 WIB
}
```
Job mengakses Bot API langsung (`bot.api.sendMessage`) untuk DM admin/reminder.

### 7.5 Keyboards, i18n, decorators
- **Keyboards:** `InlineKeyboard`/`Keyboard` grammY menggantikan
  `InlineKeyboardMarkup`. Port `admin_kb.py`/`customer_kb.py` jadi builder TS.
- **i18n:** copy `locales/{en,id}.json` apa adanya. Pakai `@grammyjs/i18n` atau
  loader sendiri `t(ctx, "key", args)` membaca `ctx.session.lang` (default dari
  `User.language`). Notifier & web pakai loader `@app/core/i18n` yang sama.
- **decorators.py:** `safe_handler` → middleware try/catch global (`bot.catch`) +
  per-handler wrapper; `admin_only` → middleware cek `isAdmin(ctx.from.id)`;
  `rate_limit` → `@grammyjs/ratelimiter` atau Map in-memory (sama seperti Python).

---

## 8. Migrasi web-admin (FastAPI → Fastify + Nunjucks)

### 8.1 Pemetaan
| FastAPI | Fastify |
|---|---|
| `APIRouter` | plugin terdaftar via `app.register(routes, { prefix })` |
| `Depends(current_admin)` | preHandler hook / decorator `app.decorate("currentAdmin")` |
| `Depends(csrf_protect)` | preHandler cek `body.csrf_token === session.csrf` |
| `Jinja2Templates` | `@fastify/view` + Nunjucks (`reply.view("orders.njk", data)`) |
| filter Jinja `money`/`localdt` | `env.addFilter("money", ...)` Nunjucks |
| `RedirectResponse(303)` | `reply.code(303).redirect(url)` |
| `Form(...)` | `@fastify/formbody` → `request.body` |
| `request.cookies` | `@fastify/cookie` |
| exception handler | `app.setErrorHandler(...)` → render `error.njk` |

### 8.2 Auth — ganti itsdangerous
Cookie ber-tanda diganti `@fastify/cookie` dengan `signed: true` (HMAC) atau JWT
(`jose`). Struktur payload tetap `{u,t,j,c}`. Logika sama persis:
- hash password: `bcrypt.hash`/`compare` (kompatibel dengan hash bcrypt Python yang
  sudah ada di `settings`!).
- jti server-side: simpan/rotasi di `settings` key `web_session_jti:<tg>`; verifikasi
  tiap request (logout = rotasi jti → cookie lama mati).
- rate-limit login: Map in-memory (sama).

```ts
// preHandler currentAdmin
app.decorate("currentAdmin", async (req, reply) => {
  const raw = req.cookies[config.WEB_COOKIE_NAME];
  const unsigned = raw && app.unsignCookie(raw);
  const data = unsigned?.valid ? JSON.parse(unsigned.value) : null;
  if (!data) return reply.code(303).redirect("/login");
  const stored = await getSetting(prisma, sessionJtiKey(data.t));
  if (!stored || stored !== data.j) return reply.code(303).redirect("/login");
  req.admin = data;
});
```

### 8.3 Templates Jinja → Nunjucks
Nunjucks ≈ Jinja2 (mendukung `{% extends %}`, `{% block %}`, `{% macro %}`, filter).
Port 18 file `.html` → `.njk`. Yang perlu disesuaikan:
- `{{ x|money }}`, `{{ ts|localdt }}` → daftarkan filter di `env`.
- global `currency`, `tzname` → `env.addGlobal(...)`.
- macro `csrf_field(admin)`, `flash`, `status_badge` → identik di Nunjucks.
- HTMX `hx-headers` CSRF & Tailwind CDN: **tidak berubah** (murni frontend).

### 8.4 Routes
Port satu-per-satu: `auth, dashboard, stock, orders, catalog, vouchers, users,
support, settings, audit`. Logika sama: panggil CRUD `@app/db`, `logAdminAction`
di tiap perubahan state, PRG + flash via query string, jangan bocorkan rahasia.
**Acceptance lama tetap berlaku** (approve→delivered+outbox+audit; logout invalidasi;
tiap endpoint mutasi punya happy + auth-fail test).

---

## 9. Migrasi notifier (testimoni)

Paling kecil & paling aman dimigrasi **pertama** (lihat §13). Port langsung:

```ts
// apps/notifier/src/dispatcher.ts
import { Bot, GrammyError } from "grammy";
export async function runDispatcher(bot: Bot) {
  for (;;) {
    try { await drainBatch(bot); }
    catch (e) { logger.error({ e }, "dispatcher tick error"); }
    await sleep(config.NOTIF_POLL_INTERVAL_SECONDS * 1000);
  }
}
async function drainBatch(bot: Bot) {
  const pending = await fetchPendingNotifications(prisma, 50);
  for (const row of pending) {
    const payload = JSON.parse(row.payloadJson);
    const text = renderTemplate(row.event, payload);   // i18n via buyer_language
    if (!text) { await markNotificationFailed(prisma, row.id, "no template", 1); continue; }
    try {
      await bot.api.sendMessage(config.PUBLIC_CHANNEL_ID!, text, { parse_mode: "HTML" });
      await markNotificationSent(prisma, row.id);
    } catch (e) {
      if (e instanceof GrammyError && e.parameters?.retry_after) {     // RetryAfter
        await sleep((e.parameters.retry_after + 1) * 1000); return;
      }
      if (e instanceof GrammyError && e.error_code === 403) {          // Forbidden
        await markNotificationFailed(prisma, row.id, "forbidden", 1); continue;
      }
      await markNotificationFailed(prisma, row.id, String(e), config.NOTIF_MAX_ATTEMPTS);
    }
  }
}
```
`templates.ts` port langsung dari `notif_bot/templates.py` (string table EN/ID,
`escape` HTML, format items).

---

## 10. i18n

- File `locales/en.json` & `locales/id.json` **dipakai ulang tanpa diubah**.
- Loader `@app/core/i18n`: `t(lang, key, args)` dengan fallback ke EN.
- Bot: `lang` dari `ctx.session.lang` (sinkron dengan `User.language`).
- Web: bahasa admin (umumnya EN) — atau ikut `Settings`.
- Notifier: `payload.buyer_language`.

---

## 11. Konfigurasi & .env (satu sumber)

Selama transisi, satu `.env` di root menyuplai Python (lama) dan Node (baru).
Tambahkan key Node tanpa menghapus key Python:

```dotenv
# --- dipakai bersama ---
BOT_TOKEN=...
BOT_USERNAME=...
ADMIN_IDS=111,222
BINANCE_PAY_ID=...
CURRENCY=USDT
PAYMENT_WINDOW_MINUTES=30
USE_UNIQUE_CENTS=1
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=en
REFERRAL_COMMISSION_PERCENT=10
DEFAULT_WARRANTY_DAYS=30
LOW_STOCK_THRESHOLD=3

# --- DB: dua format, file fisik sama ---
DATABASE_URL=sqlite+aiosqlite:///data/bot.db   # Python (lama)
DATABASE_URL_PRISMA=file:./data/bot.db         # Node/Prisma (baru)

# --- web admin ---
WEB_COOKIE_SECRET=<>=32 char>
WEB_COOKIE_NAME=stockweb_session
WEB_SESSION_TTL_HOURS=12

# --- notifier ---
NOTIF_BOT_TOKEN=...
PUBLIC_CHANNEL_ID=-100...
NOTIF_POLL_INTERVAL_SECONDS=10
NOTIF_MAX_ATTEMPTS=5
```

> **BigInt & JSON:** `telegram_id`/`PUBLIC_CHANNEL_ID` adalah `BigInt` di Prisma.
> Saat serialize ke JSON (log/web), konversi eksplisit ke string. Patch global:
> `(BigInt.prototype as any).toJSON = function(){ return this.toString(); }`.

---

## 12. Testing (pytest → Vitest)

| pytest | Vitest |
|---|---|
| `pytest` | `vitest run` |
| `pytest-asyncio` `asyncio_mode=auto` | native async di Vitest |
| fixtures (`conftest.py`) | `beforeAll/afterAll` + helper factory |
| httpx `ASGITransport` | Fastify `app.inject()` (light-my-request) — tanpa socket |
| temp SQLite file | `file:./.tmp/test.db` per-run, hapus WAL/SHM di setup |

**Pertahankan kriteria acceptance web yang sudah lulus (37 test):**
1. approve → `delivered` + 1 baris `notification_outbox` ber-`buyer_language` + audit.
2. logout meng-invalidasi sesi server-side (rotasi jti).
3. tiap endpoint mutasi: happy path + auth-fail (+ bad-CSRF).
4. rahasia tak pernah bocor (kredensial/hash/file_id) ke URL/log/HTML.

**Bot:** port 5 test bot Python (`test_order_creation`, `test_purchase_flow`,
`test_reconciliation`, `test_stock_deduction`, `test_voucher_application`) ke Vitest
sebagai test unit terhadap CRUD `@app/db` (logika murni DB, mudah diport).

---

## 13. Urutan Migrasi (fase, dari risiko terendah)

> Prinsip: tiap fase **selesai + teruji + bisa rollback** sebelum lanjut. DB tidak
> pernah diubah skemanya; Node & Python jalan berdampingan di file SQLite yang sama.

**Fase 0 — Fondasi (1–2 hari).** Setup monorepo pnpm, TS, `prisma db pull`,
baseline migration, `@app/core` (config/money/datetime/logger/i18n/errors),
`@app/db` (client + initDb + PRAGMA). Verifikasi: skrip Node bisa baca `users`,
`settings`, `notification_outbox` dari DB existing.

**Fase 1 — Notifier (1–2 hari). [paling aman]** Port `notif_bot` → `apps/notifier`.
Read-mostly (hanya update status outbox). Jalankan paralel dengan notifier Python
di staging memakai channel uji. Cutover: matikan notifier Python, nyalakan Node.
Rollback = balik nyalakan Python. **Tidak menyentuh** alur order.

**Fase 2 — Port CRUD lengkap ke `@app/db` (3–5 hari).** Port `crud.py` per-domain +
unit test (port 5 test bot). Ini prasyarat untuk web & bot. Belum ada service baru
yang live; cuma library + test.

**Fase 3 — Web admin (4–6 hari).** Port `apps/web-admin` (Fastify+Nunjucks+auth+
routes+templates). bcrypt kompatibel → admin existing bisa login tanpa reset.
Port 37 test. Cutover: arahkan reverse-proxy (Caddy/nginx) dari uvicorn → Fastify.
Rollback = arahkan balik. Bot Python masih jalan.

**Fase 4 — Order-bot (7–12 hari). [paling besar & berisiko]** Port handlers,
15 conversation, keyboards, jobs, messages, command menu. Uji intensif di
**bot uji terpisah** (token & DB uji). Audit khusus: alokasi/approve stok (race),
outbox (transaksi sama), pembulatan Decimal, FSM replay-safety.

**Fase 5 — Cutover bot (1 hari + jendela pengawasan).** Hentikan bot Python,
nyalakan bot Node dengan token produksi (`drop_pending_updates: true` agar update
basi dibuang). Pantau 24–48 jam. Rollback = stop Node, start Python (DB tak berubah).

**Fase 6 — Pembersihan.** Hapus venv/requirements/alembic Python, kode lama,
`DATABASE_URL` lama. Opsional: rencanakan migrasi SQLite→Postgres jika butuh
concurrency tulis lebih tinggi (lihat §5.4).

---

## 14. Risiko & Gotcha (wajib diperhatikan)

1. **Decimal vs Float.** Jangan pernah pakai `Number` untuk uang. Prisma `Decimal`
   → tetap decimal.js. Quantize 4 dp di satu titik (`money()`), bandingkan dengan
   `.equals()`.
2. **FSM replay (grammY conversations).** Efek samping harus di `conv.external`.
   Salah port = double-charge / double-allocate. Review tiap conversation.
3. **Reserved-stock race.** Wajib transaksi + guard `where:{status:"available"}`.
   Uji dengan order paralel (lihat `test_stock_deduction`).
4. **Outbox atomicity.** `enqueueNotification` harus di transaksi yang sama dengan
   `approveOrder`. Kalau terpisah, Telegram down bisa bikin order delivered tanpa
   testimoni (atau sebaliknya).
5. **BigInt serialization.** `telegram_id` BigInt → set `toJSON` global, hati-hati
   saat `JSON.stringify` payload/log.
6. **WAL & SQLITE_BUSY.** Set `busy_timeout`. Satu writer; banyak service nulis
   bersamaan bisa kena lock — transaksi pendek, jangan tahan lock lama.
7. **bcrypt cost.** Pakai cost yang sama (12) agar hash existing tervalidasi & baru
   konsisten. `bcrypt` (native) lebih cepat dari `bcryptjs`.
8. **Enum sebagai string.** Jangan ubah jadi enum native SQLite — akan memutus
   kompatibilitas data lama. Validasi via zod di boundary input.
9. **Timezone.** Simpan UTC, tampilkan `Asia/Jakarta` (luxon). Job harian 09:00
   harus pakai `{ timezone }` di croner — bukan UTC.
10. **parse_mode HTML.** PTB pakai `Defaults(HTML)`. grammY tidak punya default
    global → set `parse_mode:"HTML"` di tiap reply, atau pakai plugin
    `parse-mode` (`hydrateReply`/`fmt`).
11. **drop_pending_updates.** Wajib `true` saat cutover bot agar tap "Approve"/
    "Buy" yang basi tidak diproses ulang dengan konteks yang sudah berubah.
12. **Dua proses menulis DB yang sama saat paralel-run.** Aman untuk notifier
    (Fase 1) karena hanya update status outbox. **Jangan** jalankan bot Python &
    Node bersamaan pada DB produksi yang sama (dua writer alur order) — selalu
    matikan satu sebelum menyalakan yang lain (Fase 5).

---

## 15. Checklist Migrasi

**Fondasi**
- [ ] Monorepo pnpm + tsconfig base + script dev/build per app.
- [ ] `prisma db pull` menghasilkan 17 model yang cocok byte-for-byte.
- [ ] `initDb()` set PRAGMA (FK, WAL, synchronous, busy_timeout).
- [ ] `@app/core`: config(zod), money, datetime, i18n, errors, logger.

**CRUD (`@app/db`)** — port & uji tiap fungsi:
- [ ] users (upsert, get, getByTelegramId, search, setRole, setBanned, adjustWallet)
- [ ] catalog (categories, products CRUD, bulk_pricing)
- [ ] stock (bulkAdd, listForProduct, countAvailable, markDead, setNote, statusCounts, allocateOne)
- [ ] orders (createDirect, attachProof, approve, reject, list, count, get) + **outbox dlm tx**
- [ ] vouchers (create, getByCode, list, setActive)
- [ ] support (createTicket, getTicket, listOpen, addMessage, close, listMessages)
- [ ] settings (get/set/list) + audit (logAdminAction, list, count)
- [ ] notifications (enqueue, fetchPending, markSent, markFailed)
- [ ] referral (maybePayCommission)

**Notifier (Fase 1)**
- [ ] dispatcher loop + RetryAfter/Forbidden handling
- [ ] templates EN/ID identik dengan Python
- [ ] paralel-run staging → cutover → rollback diuji

**Web (Fase 3)**
- [ ] auth: signed cookie {u,t,j,c}, bcrypt, jti rotate, rate-limit, bootstrap, login, logout
- [ ] csrf preHandler + currentAdmin preHandler
- [ ] 10 router diport
- [ ] 18 template `.njk` + filter money/localdt + macro
- [ ] 37 test acceptance lulus (approve/outbox/audit, logout, auth-fail, no-secret-leak)

**Bot (Fase 4)**
- [ ] main: middleware order, sequentialize, session, conversations, runner, bot.catch
- [ ] command menu EN/ID + per-admin
- [ ] 15 conversation diport (replay-safe):
      voucher, proof, support, reject, stockUpload, broadcast, voucherCreate,
      userSearch, setting, productCreate, bulkPricing, productEdit, ticketReply,
      review, ticketUserReply
- [ ] callback router `^v1:` + handleProductNumber
- [ ] keyboards admin + customer
- [ ] 4 job croner (autoCancel, autoCloseTickets, reconcile, warranty 09:00 WIB)
- [ ] 5 test bot diport (order, purchase, reconciliation, stock, voucher)

**Cutover (Fase 5)**
- [ ] backup `data/bot.db` (+ wal/shm)
- [ ] stop Python bot → start Node bot (`drop_pending_updates:true`)
- [ ] pantau audit log + outbox + error 24–48 jam
- [ ] rencana rollback teruji (stop Node, start Python)

---

## 16. Estimasi Waktu

| Fase | Konten | Estimasi |
|---|---|---|
| 0 | Fondasi monorepo + Prisma + core | 1–2 hari |
| 1 | Notifier | 1–2 hari |
| 2 | Port CRUD + unit test | 3–5 hari |
| 3 | Web admin | 4–6 hari |
| 4 | Order-bot (handlers+conv+jobs) | 7–12 hari |
| 5 | Cutover + pengawasan | 1–2 hari |
| 6 | Pembersihan (+opsi Postgres) | 1–3 hari |
| | **Total** | **±3–5 minggu** (1 dev) |

---

## 17. Keputusan yang Perlu Dikonfirmasi

1. **ORM:** Prisma (default, DX terbaik) vs Drizzle (kontrol SQL/locking lebih dekat
   ke SQLAlchemy). → Rekomendasi: **Prisma**, kecuali rencananya segera ke Postgres
   dengan locking paralel berat.
2. **Tetap SQLite atau pindah Postgres?** SQLite cukup untuk satu writer; Postgres
   bila butuh konkruensi tulis tinggi + `FOR UPDATE SKIP LOCKED`. → Rekomendasi:
   **tetap SQLite** saat migrasi, evaluasi Postgres di Fase 6.
3. **Template engine web:** Nunjucks (paling mirip Jinja2, port cepat) vs menulis
   ulang ke React/SSR. → Rekomendasi: **Nunjucks** (minim perubahan, HTMX tetap).
4. **Big-bang vs strangler:** dokumen ini mengasumsikan **strangler** (per service).
   Big-bang lebih cepat tapi jauh lebih berisiko untuk bot pembayaran.
```
