# Phase 0 — Project Understanding

> Jalankan ini **pertama**. Outputnya jadi rujukan fase-fase berikut. **Read-only — jangan ubah kode.**

---

## Konteks Proyek (ringkas, untuk agent standalone)
Monorepo **pnpm + TypeScript**.
- **apps/order-bot** — grammY (Telegram): `handlers/`, `conversations/`, `keyboards/`, `jobs/`, `payments/`.
- **apps/web-admin** — Fastify + Nunjucks + HTMX: `routes/`, `plugins/auth`, `lib/upload`.
- **apps/storefront** — Fastify + Nunjucks: `routes/`, `cards.ts`, `views/`.
- **apps/notifier** — pengirim antrian Telegram.
- **apps/server** — composition root produksi (satu proses, satu `PrismaClient`).
- **packages/core** — `money` (Decimal), `i18n` (en/id), `config` (zod), `password` (bcrypt), `logger` (pino).
- **packages/db** — Prisma + `crud/*` (per-domain) + `client.ts` (PRAGMA WAL).
- **DB** — SQLite tunggal `data/bot.db` (single-writer, WAL).

**Aturan inti** (CLAUDE.md): money selalu Decimal; tak ada SQL mentah di route; web TAK PERNAH kirim Telegram (enqueue `notification_outbox`); jangan log secret; CSRF `csrfProtect` di tiap route mutasi.

---

## Objective
Bangun peta sistem yang akurat sebelum audit teknis.

## Langkah Investigasi (jalankan & catat hasilnya)
1. **Struktur & ukuran:**
   - `cat pnpm-workspace.yaml`; `cat package.json` (scripts).
   - File terbesar (kandidat hotspot): `find apps packages -name "*.ts" -not -path "*/node_modules/*" -not -name "*.test.ts" | xargs wc -l | sort -rn | head -20`.
   - Template terbesar: `find apps -name "*.njk" | xargs wc -l | sort -rn | head -10`.
2. **Tech stack & dependency:** baca tiap `apps/*/package.json` & `packages/*/package.json` — catat framework, versi kunci (Fastify, grammY, Prisma, Nunjucks), dan dependency eksternal.
3. **Database:** `wc -l prisma/schema.prisma`; daftar model (`grep -nE "^model " prisma/schema.prisma`), index (`grep -nE "@@index" prisma/schema.prisma`), relasi. Catat PRAGMA di `packages/db/src/client.ts`.
4. **Auth:** baca `apps/web-admin/src/plugins/auth.ts`, `apps/web-admin/src/auth.ts` (sesi, RBAC, TOTP 2FA), `apps/storefront/src/plugins/auth.ts`.
5. **Routing/API:** daftar route: `grep -rn "app.get\|app.post\|app.put\|app.delete" apps/web-admin/src apps/storefront/src --include=*.ts`.
6. **Queue/jobs:** `apps/order-bot/src/jobs/index.ts`; tabel `notification_outbox`, `broadcasts`.
7. **External services:** Telegram (`lib/telegramCheck.ts`), Bybit (`payments/bybitDeposit.ts`), Binance (`payments/binanceInternal.ts`), SMTP (`packages/core` mailer).
8. **Deploy:** `Dockerfile`, `docker-compose.yml`, `apps/server/src/index.ts`.
9. **Env:** `packages/core/src/config.ts` — daftar semua env + default.

## Petunjuk awal (verifikasi, jangan telan mentah)
- 24 model, ~28 `@@index`, FK aktif, WAL (`client.ts:31-34`).
- File besar: `order-bot/conversations/admin.ts` (~934), `handlers/checkout.ts` (~809), `crud/orders.ts` (~765).
- Composition root: `apps/server/src/index.ts` (~303 loc).

## Output → tulis ke `audit/reports/phase-00-project-understanding.md`
### 1. Architecture Overview
- Folder tree penting (anotasi tanggung jawab tiap folder)
- Layer aplikasi & **flow request** (web: route → preHandler → crud → Prisma → SQLite; bot: middleware → handler/conversation → crud)
- Database schema overview (model + relasi utama)
- Service dependency graph (siapa memanggil siapa; service eksternal)
### 2. Tech Stack & Dependencies
Tabel: paket, versi, peran.
### 3. Potential High Risk Areas
Untuk tiap area beri lokasi file: **Payment, Authentication, Admin panel, File upload, Webhook, Background jobs**.

## Constraint
**Jangan mengubah kode apa pun.**
