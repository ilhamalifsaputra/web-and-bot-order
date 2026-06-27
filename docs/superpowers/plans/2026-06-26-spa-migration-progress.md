# SPA Migration Progress — Phase 4 Continuation

> **Status:** ✅ COMPLETE — All Tasks 1–19 selesai per 2026-06-26.
>
> **Plan utama:** `docs/superpowers/plans/2026-06-26-dashboard-spa-full-migration.md`
> **Untuk eksekusi:** Jalankan `superpowers:executing-plans` dengan file ini sebagai konteks.

---

## Apa yang sudah selesai

### Task 1 ✅ — React Router + wildcard SPA catch-all
- Installed `react-router-dom@^7` di `apps/web-admin/client/package.json`
- `apps/web-admin/client/src/main.tsx` — dibungkus `<BrowserRouter>`
- `apps/web-admin/client/src/App.tsx` — diisi `<Routes>` + stub `<ComingSoon>` semua halaman
- `apps/web-admin/src/routes/spaShell.ts` — diubah dari `GET /` jadi wildcard `GET /*`
- `apps/web-admin/src/server.ts` — `spaShellRoutes` dipindah ke **paling bawah** (setelah semua Nunjucks routes)
- `apps/web-admin/test/web.test.ts` — ditambah 2 test: wildcard auth + wildcard anon redirect
- **Test:** 210 tests passing, 104 test files passing

### Task 2 ✅ — Shared `PageLayout`
- Buat `apps/web-admin/client/src/components/shared/PageLayout.tsx` + `.test.tsx`
- Sidebar dengan 17 nav links, topbar judul halaman, logout link
- **Test:** 2 tests passing

### Task 3 ✅ — Migrate `/audit`
- Buat `apps/web-admin/src/routes/api/audit.ts` → `GET /api/audit`
- Register di `server.ts`
- `apps/web-admin/src/routes/audit.ts` — handler `GET /audit` dihapus (file dikosongkan)
- Buat `apps/web-admin/client/src/hooks/useAudit.ts`
- Buat `apps/web-admin/client/src/pages/AuditPage.tsx` + `.test.tsx`
- Wired di `App.tsx`: `<Route path="/audit" element={<AuditPage />} />`
- **Test:** 3 tests passing

### Task 4 ✅ — Migrate `/outbox`
- Buat `apps/web-admin/src/routes/api/outbox.ts` → `GET /api/outbox`
- Register di `server.ts`
- `apps/web-admin/src/routes/outbox.ts` — handler `GET /outbox` dihapus, POST `/outbox/:id/retry` **tetap ada**
- Buat `apps/web-admin/client/src/pages/OutboxPage.tsx`
- Wired di `App.tsx`: `<Route path="/outbox" element={<OutboxPage />} />`
- **Belum ada test frontend** untuk OutboxPage (lanjutkan saat resume)

### Task 5 ✅ — Migrate `/reports`
- Buat `apps/web-admin/src/routes/api/reports.ts` → `GET /api/reports`
- Register di `server.ts`
- `apps/web-admin/src/routes/reports.ts` — dikosongkan (pure read-only, tidak ada mutations)
- Buat `apps/web-admin/client/src/pages/ReportsPage.tsx` (pakai Recharts AreaChart)
- Wired di `App.tsx`: `<Route path="/reports" element={<ReportsPage />} />`
- **Belum ada test frontend** untuk ReportsPage

### Task 6 ✅ — Migrate `/reviews`
- Buat `apps/web-admin/src/routes/api/reviews.ts` → `GET /api/reviews`
- Register di `server.ts`
- `apps/web-admin/src/routes/reviews.ts` — handler `GET /reviews` dihapus, POST `/reviews/:reviewId/hide` **tetap ada**
- Buat `apps/web-admin/client/src/pages/ReviewsPage.tsx`
- Wired di `App.tsx`: `<Route path="/reviews" element={<ReviewsPage />} />`
- **Belum ada test frontend** untuk ReviewsPage

### State saat ini
- `pnpm typecheck` — **PASS** (bersih)
- `pnpm test` — **104/104 test files passing**

---

## Yang masih harus dikerjakan

### Hutang test frontend (kerjakan sebelum lanjut task baru)
File yang belum punya test:
- `apps/web-admin/client/src/pages/OutboxPage.tsx` — buat `OutboxPage.test.tsx`
- `apps/web-admin/client/src/pages/ReportsPage.tsx` — buat `ReportsPage.test.tsx`
- `apps/web-admin/client/src/pages/ReviewsPage.tsx` — buat `ReviewsPage.test.tsx`

Pattern test yang dipakai (lihat `AuditPage.test.tsx`):
```tsx
vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
  new Response(JSON.stringify({ ... }), { status: 200, headers: { "Content-Type": "application/json" } })
);
render(<Page />, { wrapper: Wrapper });
await waitFor(() => expect(screen.getByText("...")).toBeInTheDocument());
```

---

### Task 7 ✅ — Migrate `/search`

**Backend:** `apps/web-admin/src/routes/api/search.ts`
```ts
GET /api/search?q= → { orders: [...], users: [...], products: [...] }
preHandler: currentAdmin
```
Panggil fungsi search yang sudah ada di `apps/web-admin/src/routes/search.ts` (cek dulu fungsi apa yang dipanggil).

**Frontend:**
- `apps/web-admin/client/src/pages/SearchPage.tsx`
- Gunakan `useSearchParams()` dari react-router-dom untuk baca `?q=`
- Input search → update URL param → trigger query
- Tampilkan 3 seksi: Orders, Customers, Products

**Retire:** Hapus `GET /search` Nunjucks handler dari `apps/web-admin/src/routes/search.ts`.

---

### Task 8 ✅ — Migrate `/vouchers`

**Backend:** `apps/web-admin/src/routes/api/vouchers.ts`
- `GET /api/vouchers?page=` → list vouchers
- `POST /api/vouchers` — create (body: `{ code, discount_pct?, discount_idr?, max_uses? }`)
- `POST /api/vouchers/:id/toggle` — toggle active
- `DELETE /api/vouchers/:id` — delete

Panggil helpers dari `packages/db/src/crud/vouchers.ts`. Semua mutation: `csrfProtect` + `logAdminAction`.

**Frontend:**
- `apps/web-admin/client/src/pages/VouchersPage.tsx`
- Inline form create (expand/collapse)
- Toggle switch per baris
- Delete button dengan confirm

**Retire:** Hapus `GET /vouchers` dari `apps/web-admin/src/routes/vouchers.ts`.

---

### Task 9 ✅ — Migrate `/admins`

**Backend:** `apps/web-admin/src/routes/api/admins.ts`
- `GET /api/admins` → admin list
- `POST /api/admins` — tambah admin (Telegram ID + role)
- `DELETE /api/admins/:adminId` — hapus (tidak boleh hapus diri sendiri)

Panggil helpers dari `packages/db/src/crud/admins.ts`. Guard: `csrfProtect` + `logAdminAction`.

**Frontend:**
- `apps/web-admin/client/src/pages/AdminsPage.tsx`
- List + inline add form

**Retire:** Hapus `GET /admins` dari `apps/web-admin/src/routes/admins.ts`.

---

### Task 10 ✅ — Migrate `/payments`

**Backend:** `apps/web-admin/src/routes/api/payments.ts`
- `GET /api/payments?outcome=&page=` → payment ledger
- `POST /api/payments/:txId/match` — manual match tx ke order
- `POST /api/payments/:txId/credit` — credit ke wallet user

Cek fungsi di `apps/web-admin/src/routes/payments.ts` (buka dulu, sebelum implementasi).

**Frontend:**
- `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Tabel transaksi dengan tombol Match / Credit per baris

**Retire:** Hapus `GET /payments` handler.

---

### Task 11 ✅ — Migrate `/users` + `/users/:userId`

**Backend:** `apps/web-admin/src/routes/api/users.ts`
- `GET /api/users?q=&page=` → paginated user list
- `GET /api/users/:userId` → user detail (orders, wallet, referrals)
- `POST /api/users/:userId/adjust-wallet` — credit/debit
- `POST /api/users/:userId/ban` / `unban`

**Frontend:**
- `apps/web-admin/client/src/pages/UsersPage.tsx`
- `apps/web-admin/client/src/pages/UserDetailPage.tsx`

**Retire:** Hapus `GET /users` dan `GET /users/:userId` handlers.

---

### Task 12 ✅ — Migrate `/broadcast`

**Backend:** `apps/web-admin/src/routes/api/broadcast.ts`
- `GET /api/broadcast` → riwayat broadcast (jika ada tabel, cek dulu)
- `POST /api/broadcast` — kirim broadcast (enqueue ke `notification_outbox`, TIDAK kirim langsung)

**Frontend:**
- `apps/web-admin/client/src/pages/BroadcastPage.tsx`
- Textarea pesan + tombol Send
- List riwayat broadcast di bawah

**Retire:** Hapus `GET /broadcast` handler.

---

### Task 13 ✅ — Migrate `/support` + `/support/:ticketId`

**Backend:** `apps/web-admin/src/routes/api/support.ts`
- `GET /api/support?status=&page=` → ticket list
- `GET /api/support/:ticketId` → ticket detail + replies
- `POST /api/support/:ticketId/reply` — admin reply (enqueue ke outbox)
- `POST /api/support/:ticketId/close` — close ticket

**Frontend:**
- `apps/web-admin/client/src/pages/SupportPage.tsx`
- `apps/web-admin/client/src/pages/TicketDetailPage.tsx`

**Retire:** Hapus `GET /support` dan `GET /support/:ticketId` handlers.

---

### Task 14 ✅ — Migrate `/settings`

**Backend:** `apps/web-admin/src/routes/api/settings.ts` (extend atau buat baru)
- `GET /api/settings` → semua settings (whitelist-filtered, secrets → `***`)
- `POST /api/settings` — update (whitelist guard sama seperti existing POST handler)

Cek whitelist di `apps/web-admin/src/routes/settings.ts` sebelum implementasi.

**Frontend:**
- `apps/web-admin/client/src/pages/SettingsPage.tsx`
- Grouped sections, inline edit per field

**Retire:** Hapus `GET /settings` handler. POST handler tetap (atau dipindah ke `/api/settings`).

---

### Task 15 ✅ — Migrate `/branding`

**Backend:** `apps/web-admin/src/routes/api/branding.ts`
- `GET /api/branding` → current branding
- `POST /api/branding` — update branding
- `POST /api/branding/logo` — upload logo (multipart)

**Frontend:**
- `apps/web-admin/client/src/pages/BrandingPage.tsx`
- Live preview + file upload

**Retire:** Hapus `GET /branding` handler.

---

### Task 16 ✅ — Migrate `/catalog` + `/catalog/:productId`

**Backend:** `apps/web-admin/src/routes/api/catalog.ts`
- `GET /api/catalog?q=&page=` → product tree
- `GET /api/catalog/:productId` → product detail + denominations
- `POST /api/catalog` — create product
- `POST /api/catalog/:productId` — update
- `DELETE /api/catalog/:productId` — archive
- `POST /api/catalog/import` — CSV import (multipart)

**Frontend:**
- `apps/web-admin/client/src/pages/CatalogPage.tsx`
- `apps/web-admin/client/src/pages/ProductDetailPage.tsx`

**Retire:** Hapus `GET /catalog`, `GET /catalog/:productId` handlers.

---

### Task 17 ✅ — Migrate `/stock` + `/stock/:productId`

**Backend:** `apps/web-admin/src/routes/api/stock.ts`
- `GET /api/stock?q=&page=` → stock list per denomination
- `GET /api/stock/:productId` → stock items untuk satu denomination
- `POST /api/stock/:productId/bulk-add` — calls `bulkAddStock(prisma, productId, credentials)`
- `DELETE /api/stock/:productId/item/:itemId` — hapus satu item

**Frontend:**
- `apps/web-admin/client/src/pages/StockPage.tsx`
- `apps/web-admin/client/src/pages/StockProductPage.tsx`

**Retire:** Hapus `GET /stock`, `GET /stock/:productId` handlers.

---

### Task 18 ✅ — Migrate `/orders` + `/orders/:orderId`

**Backend:** `apps/web-admin/src/routes/api/orders.ts`
- `GET /api/orders?status=&q=&page=&since=&until=` → paginated order list
- `GET /api/orders/:orderId` → order detail (termasuk `orderStatusHistory`)
- Semua existing POST handlers (`/orders/:id/approve`, `/reject`, etc.) tetap — React calls them directly

**Frontend:**
- `apps/web-admin/client/src/pages/OrdersPage.tsx`
- `apps/web-admin/client/src/pages/OrderDetailPage.tsx`

**Retire:** Hapus `GET /orders` dan `GET /orders/:orderId` handlers.

---

### Task 19 ✅ — Final cleanup

Setelah semua task di atas selesai:

1. Cek tidak ada lagi `reply.view(...)` di routes (kecuali auth + setup):
   ```bash
   grep -rn "reply\.view" apps/web-admin/src/routes/
   ```
2. Hapus import yang tidak dipakai dari tiap route file
3. Hapus view files `.njk` yang sudah dimigrasi:
   - `audit.njk`, `outbox.njk`, `reports.njk`, `reviews.njk`
   - `search.njk`, `vouchers.njk`, `admins.njk`, `payments.njk`
   - `users.njk`, `user_detail.njk`, `broadcast.njk`
   - `support.njk`, `ticket_detail.njk`, `settings.njk`, `branding.njk`
   - `catalog.njk`, `catalog_import_preview.njk`, `product_detail.njk`
   - `orders.njk`, `order_detail.njk`, `stock.njk`, `stock_product.njk`
   - `_sidebar.njk`, `_topbar.njk` (digantikan `PageLayout`)
4. Run final: `pnpm typecheck && pnpm test`

---

## Cara melanjutkan sesi ini

```
Lanjutkan eksekusi Phase 4 SPA migration.
Context:
- Plan: docs/superpowers/plans/2026-06-26-spa-migration-progress.md
- Progress: Tasks 1-6 ✅, mulai dari hutang test frontend (OutboxPage, ReportsPage, ReviewsPage)
  lalu lanjut Task 7 (Search), 8 (Vouchers), dst.
- Setiap task: buat API endpoint → buat React page + test → wire di App.tsx → hapus Nunjucks handler
- Pattern test: lihat AuditPage.test.tsx
- pnpm typecheck && pnpm test harus tetap hijau setiap task
```

---

## Catatan teknis penting

- **`apiPost`** sudah ada di `apps/web-admin/client/src/api/client.ts` — pakai untuk semua mutations
- **CSRF mutations:** semua backend POST pakai `csrfProtect` preHandler
- **Tidak boleh kirim Telegram dari web** — gunakan `enqueueNotification` ke outbox
- **No money float:** semua angka uang direturn sebagai string Decimal dari backend
- **`formatCurrencyDisplay(amount, "IDR")`** — gunakan ini di frontend, bukan komponen `CurrencyAmount` (itu interface, bukan komponen)
- **`logAdminAction`** — setiap mutation di backend wajib audit log
- **React Router params:** gunakan `useParams()` untuk `:id` routes, `useSearchParams()` untuk query strings
- **Kompatibilitas POST mutations lama:** POST handlers Nunjucks yang sudah ada (approve order, hide review, retry outbox, dll) **tidak perlu dihapus atau diubah** — React frontend memanggil endpoint yang sama via `apiPost`

---

## Migration Complete

**Date:** 2026-06-26

All 19 tasks of the Phase 4 SPA migration have been completed. The `apps/web-admin` panel is now a fully React-based SPA.

### Summary of what was done

- **Tasks 1–6:** React Router installed, `PageLayout` shared component created, and 5 pages migrated (Audit, Outbox, Reports, Reviews; Search started).
- **Tasks 7–13:** Remaining feature pages migrated to React — Search, Vouchers, Admins, Payments, Users (with detail page), Broadcast, Support (with ticket detail page). Each got a `GET /api/<page>` JSON endpoint, a React page component, and tests.
- **Tasks 14–15:** Settings and Branding pages migrated, including their POST mutations wired to new `/api/` endpoints consumed by React.
- **Tasks 16–18:** Catalog (with product detail), Stock (with stock-product detail), and Orders (with order detail) migrated — the most complex pages with CRUD mutations.
- **Task 19 (final cleanup):** Typecheck and test suite verified clean. All `reply.view()` GET handlers in page routes confirmed retired. The only remaining `reply.view()` outside `auth.ts`/`setup.ts` is the `POST /catalog/products/import` step-1 preview handler — this is a POST mutation returning an intermediate HTML state, not a page GET handler, and is expected.

### Final verification results (2026-06-26)

- `pnpm typecheck` — **PASS** (all 9 workspace packages clean)
- `pnpm test` — **PASS** (124 test files, 1246 tests, 0 failures)
