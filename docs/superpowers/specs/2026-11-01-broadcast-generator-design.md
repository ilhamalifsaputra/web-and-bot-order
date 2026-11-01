# Broadcast Generator (Phase 1) — Design

**Date:** 2026-11-01
**Status:** Approved in brainstorming, awaiting spec review
**Source:** owner's `INVENTORY_AND_BROADCAST_SYSTEM_V2.md` (generic spec written without
repo access), reconciled with the code on `master` 2ebb5de0 and with three Opus UX
reviews (admin, bot customer, channel follower).

## 1. Problem

Admins build stock broadcasts by hand. They export a CSV that mixes manual-inventory
SKUs with Digiflazz SKUs, split it, then type the post. That costs time, mislabels
items, and lets the post drift from what the storefront actually sells.

The generator reads the same availability data the storefront uses, groups and
labels every item automatically, and produces:

- a **bot DM broadcast** to bot users (through the existing `Broadcast` pipeline), and
- a **channel post** the admin copies into the shop's Telegram channel.

The mixed-CSV importer from the source spec is **out of scope**. The owner confirmed
that the CSV existed only to build broadcast text.

## 2. Decisions (owner-approved)

| # | Decision |
|---|---|
| D1 | The generator is the first sub-project. The CSV importer and the availability contract rework are not built. |
| D2 | There are two equal actions. **Kirim via bot** sends a DM through the existing `Broadcast` + worker. **Salin untuk channel** copies the post for pasting into the channel. |
| D3 | Telegram only. There is no WhatsApp format. |
| D4 | One message holds manual and provider items, grouped automatically. |
| D5 | Provider status comes from the DB, not from a live call. The UI shows the age of the data and warns when it is older than the threshold (default **90 min**, configurable, because the catalog resync runs hourly). A **Sinkron sekarang** button sits next to the warning. The admin may proceed anyway. |
| D6 | v1 types: **Update Stok, Restock/Baru, Gangguan, Layanan Pulih, Pengumuman Umum**. |
| D7 | Item selection uses shared **presets** plus **Sama seperti terakhir**. Inactive and sold-out items can be selected but are flagged, and presets never auto-check inactive items. |
| D8 | Statuses are **✅ Tersedia**, **⛔ Habis** and **🔧 Gangguan**. No stock numbers and no "menipis" label. |
| D9 | Languages are ID and EN. The **DM goes out in each recipient's `User.language`**. The ID/EN toggle sets the preview and the channel copy. Default is ID. |
| D10 | The admin can edit **Judul**, **Catatan pembuka** (optional), **Keterangan** (required for Gangguan and Layanan Pulih), and **Footer** (default from Settings). The product list is locked to the data. |
| D11 | Scheduled sends are allowed for every type. **Status is re-resolved at send time.** Items that became unavailable are dropped. If nothing is left, the send is cancelled. |
| D12 | Premium Apps and Game Top Up keep separate terminology and icons (AGENTS.md). |

### UX rules adopted from the persona reviews

1. 🔧 marks Gangguan and ⛔ marks only Habis.
2. The header carries the date, time and zone (`· 1 Nov 2026, 14.30 WIB`), plus the line "Stok bisa berubah, cek terbaru di bot."
3. **DM shows only ✅ items.** The channel also shows ⛔/🔧 items. In the channel, a product whose variants are all sold out collapses to one line ("Netflix Premium: ⛔ Habis semua").
4. Within a product, available variants are listed first.
5. DM inline buttons:
   - When exactly **one denomination** is shown, the DM has two buttons, each on its own row: **🛒 Beli sekarang** (URL `https://t.me/<bot>?start=prod_<denominationId>`, the existing deep link) and **🏠 Menu** (callback `v1:menu:main`).
   - Otherwise the DM has one button, **🛒 Beli sekarang**, with callback `v1:menu:main`. A second button that does the same thing is not added.
   - A **Gangguan** DM only ever has **🏠 Menu**. It lists SKUs that cannot be bought, so it never offers a buy button.

   The channel post ends with a `https://t.me/<bot>?start=channel` link.
6. No template promises an outcome ("pesanan tetap diproses"). Gangguan uses "Status pesanan kami kabari lewat bot."
7. Gangguan and Layanan Pulih times carry the zone: "Sejak 14.00 WIB · perkiraan pulih 15.00 WIB."
8. Per-type selection defaults:
   - Restock/Baru: only ✅ items.
   - Gangguan: only 🔧 items.
   - Layanan Pulih: items currently ✅ that are provider-backed.
9. **Restock/Baru** lets the admin label each item 🆕 Baru or ✅ Tersedia lagi.
10. A long channel post is split **per group** (Premium Apps / Game Top Up). Each part is a complete post with its own header and CTA.
11. The old **Restock** and **Maintenance** quick templates in `BroadcastPage.tsx` are replaced by a link to the new tab.
12. Selection works at **product level**, expandable to denominations, with **Pilih semua hasil filter**. On mobile, a sticky bar shows `12 item · 2.140 kar · [Lihat preview]` and opens the preview in a sheet.
13. **Sama seperti terakhir** says what it reuses: "(Update Stok, 13.05 oleh <admin>)".

## 3. What already exists (reuse, don't rebuild)

| Need | Existing code |
|---|---|
| Availability truth | `packages/core/src/productAvailability.ts` → `resolveDenominationAvailability`, `fulfillmentSourceOf` |
| Telling a Digiflazz outage from an admin deactivation | `packages/db/src/crud/digiflazzAutoDeactivated.ts` (setting `digiflazz_auto_deactivated_ids`) |
| DM delivery, segments, schedule, photo, flood control | `Broadcast` model, `apps/web-admin/src/routes/api/broadcast.ts`, `packages/db/src/crud/broadcasts.ts`, `drainBroadcasts` in `apps/order-bot/src/jobs/index.ts` |
| Product deep link | `?start=prod_<id>` in `apps/order-bot/src/handlers/customer.ts` |
| Button width | `visualWidth`, `packages/core/src/buttonLimits.ts` |
| RBAC and audit | `canMutate` in `apps/web-admin/src/plugins/auth.ts`, `logAdminAction` |
| Catalog resync | `resyncDigiflazzCatalog` + its lease |

### Gaps found in code

- **G1.** `resolveDenominationAvailability` returns AVAILABLE for every MANUAL and PROVIDER_API SKU. A manual Netflix SKU can therefore never show ⛔. → Per-post override **Tandai Habis di pesan ini**. It is stored in the post and applied at every re-resolve. The catalog is never touched.
- **G2.** (Resolved during planning.) `getDigiflazzSyncStatus` in `packages/db/src/crud/digiflazzSyncStatus.ts` already stores the last run's `status` and `finishedAt`. Data age = `finishedAt` when `status === "success"`. A non-success last run, or no run at all, counts as stale ("Sinkron terakhir gagal" / "Belum pernah sinkron"). No new setting is needed.
- **G5.** The admin client may not import `@app/core`. → Preview text and length are rendered **server-side** by `POST /api/broadcast/posts/preview` (debounced on the client), so the counter is the server's own number.
- **G3.** `drainBroadcasts` sends plain text with no `parse_mode` and no buttons. → New branch for generated broadcasts only. Legacy rows are unchanged.
- **G4.** The server limit is `MAX_MESSAGE = 4000` and `MAX_CAPTION = 1024`, measured on the stored string. → The generator measures rendered HTML with the same rule. The client counter calls the same shared function.

## 4. Data model

New Prisma models. Migration is additive only.

```prisma
model BroadcastPost {
  id              Int       @id @default(autoincrement())
  type            String    // STOCK_UPDATE | RESTOCK | OUTAGE | RESTORED | ANNOUNCEMENT
  language        String    // ID | EN — preview/channel language
  title           String
  intro           String?
  details         String?   // "Keterangan" (Gangguan/Pulih)
  footer          String?
  items           Json      // [{ denominationId, markSoldOut?: bool, label?: "NEW"|"BACK" }]
  plannedSnapshot Json      // frozen at copy/queue time
  sentSnapshot    Json?     // set by the worker at actual send time
  action          String    // COPIED | QUEUED
  broadcastId     Int?      @unique
  idempotencyKey  String    @unique
  createdById     Int?
  createdAt       DateTime  @default(now())
  broadcast       Broadcast? @relation(fields: [broadcastId], references: [id])
}

model BroadcastPreset {
  id              Int      @id @default(autoincrement())
  name            String   @unique
  denominationIds Int[]
  createdById     Int?
  updatedAt       DateTime @updatedAt
}
```

`Broadcast` keeps all its columns and gains nothing but the back-relation
(`post BroadcastPost?`). A `Broadcast` with a post is "generated", and one without a
post is legacy. For a generated row, `Broadcast.message` holds the planned render in
ID so the existing history list and length check keep working.

New settings:

- `broadcast_footer_id`, `broadcast_footer_en`
- `broadcast_stale_minutes` (default 90)

### Snapshot shape (no credentials, no raw stock counts)

```ts
type PostSnapshot = {
  resolvedAt: string;                 // ISO UTC
  providerSyncedAt: string | null;
  groups: Array<{
    group: "PREMIUM_APPS" | "GAME_TOPUP";
    products: Array<{
      productId: number; name: string; icon: string | null;
      items: Array<{
        denominationId: number; name: string;
        status: "AVAILABLE" | "SOLD_OUT" | "OUTAGE" | "INACTIVE" | "GONE";
        source: "INTERNAL_INVENTORY" | "PROVIDER_API" | "MANUAL";
        overridden: boolean; label: "NEW" | "BACK" | null;
      }>;
    }>;
  }>;
};
```

Status mapping:

| Condition | Status |
|---|---|
| Admin or category or product inactive, and **not** in the auto-deactivated list | INACTIVE (never rendered) |
| Inactive and in `digiflazz_auto_deactivated_ids` | OUTAGE 🔧 |
| INTERNAL_INVENTORY with stock 0 | SOLD_OUT ⛔ |
| Any SKU with `markSoldOut` | SOLD_OUT ⛔ |
| Deleted or archived | GONE (dropped, flagged in UI) |
| Otherwise | AVAILABLE ✅ |

The product group comes from the established group resolver, never from the
product name.

## 5. Components

- **`packages/db/src/crud/broadcastPosts.ts`**
  - `buildPostSnapshot(db, items, now)`
  - `createCopiedPost`
  - `createQueuedPost` (one transaction: post + `Broadcast` PENDING)
  - `listPostHistory`
  - `lastPostForReuse`
  - preset CRUD

  Tests are colocated with it.
- **`packages/core/src/broadcastRender.ts`**: a pure function `renderPost({ snapshot, type, fields, language, target: "dm" | "channel", botUsername, now, timezone })`.
  - DM returns `{ html, length, buttons }`.
  - Channel returns `{ parts: [{ html, plain, length }] }`.
  - It HTML-escapes every admin field, reads strings from `packages/core/locales/*.json`, and checks buttons with `visualWidth`.
  - `broadcastLength(text)` is shared with the server validator and the client counter.
- **`apps/web-admin/src/routes/api/broadcastPosts.ts`**:
  - `GET /api/broadcast/posts/options`: products, statuses, data age
  - `POST /api/broadcast/posts/preview`: render only, no write
  - `POST /api/broadcast/posts/copy`
  - `POST /api/broadcast/posts/send`: segment, `scheduled_at`, optional `image_url` (reuses the existing image checks)
  - `GET|POST|DELETE /api/broadcast/posts/presets`
  - `GET /api/broadcast/posts/history`
  - **Sinkron sekarang** reuses the existing `POST /api/catalog/digiflazz/sync/run`, which already handles credentials, rc 83 and errors. No new sync endpoint.

  Every mutation goes through `csrfProtect`, `canMutate` under the `/api/broadcast` prefix, and an idempotency key. Each one is audited with a plain sentence, for example `"Queued a stock-update broadcast with 12 products to 340 recipients in segment ALL."`
- **Order-bot `drainBroadcasts`**: a generated row rebuilds the snapshot from `post.items`, drops non-AVAILABLE items, and writes `sentSnapshot`. It renders once per language (ID and EN) and sends each recipient their language with `parse_mode: "HTML"` and the inline keyboard. With a photo, the text goes as a caption. If no items are left, the row becomes `CANCELLED` with `failureReason` "Semua item habis saat jam kirim", an audit row is written, and nothing is sent. Legacy rows keep the current plain-text path exactly.
- **Web-admin client**: `BroadcastPage` gets the tabs **Kirim Pesan** (existing) and **Buat dari Produk** (new). The new page is `pages/broadcast/GeneratorTab.tsx` and is split into `TypePicker`, `ItemPicker` (presets, filters, product/denomination tree), `PostFields`, `PostPreview`, `SendDialog` (reuses `ConfirmDialog` and segment counts) and `PostHistory`. Copy writes `text/html` + `text/plain` through `ClipboardItem`. If that fails, it shows a selected textarea instead.
- **Settings page**: default footer (ID/EN) and the stale-data threshold.

## 6. UI

```
① Tipe     [Update Stok] [Restock/Baru] [Gangguan] [Layanan Pulih] [Pengumuman]
② Produk   Preset [Daftar Harian ▾] [Sama seperti terakhir (Update Stok, 13.05 oleh …)] [+ Simpan]
           🔍 cari…  Grup [Semua|Premium Apps|Game Top Up]  Kategori ▾  [Pilih semua hasil filter]
           ▸ ☑ Netflix Premium (2)        ✅ 1 · ⛔ 1
               ☑ 1 Bulan Sharing   ✅ Tersedia     [Tandai Habis]
               ☑ 1 Bulan Private   ⛔ Habis
           ▸ ☑ Mobile Legends (2)         ✅ 1 · 🔧 1
           ⚠ Status Digiflazz per 13.10 (95 menit lalu)  [Sinkron sekarang]
③ Isi      Judul · Catatan pembuka · Keterangan* · Footer ✎ · Bahasa (ID|EN)
   Preview  [DM bot | Channel]                    2.140 / 4.000
   [📤 Kirim via bot…]   [📋 Salin untuk channel]
```

- On desktop, the preview is a live right column. On mobile, a sticky action bar opens a preview sheet.
- **Send dialog**: segment with recipient count, schedule, optional photo, the line "Status stok diperbarui otomatis saat dikirim" when scheduled, the stale-data banner repeated, and the existing confirm wording.
- **History tab**: time, type, admin, action (Disalin / Dikirim #id → link to the `Broadcast` row with its Cancel), and **Lihat snapshot**, which shows planned and sent side by side with dropped items marked "dibuang saat kirim (Habis)". **Pakai lagi** is also available.
- The copy buttons mark each part with a persistent "Disalin ✓". Copying again in one session reuses the same post (same idempotency key) instead of adding history rows.
- Admin UI chrome (buttons, labels, banners) follows the existing admin language,
  which is English today, so both tabs match. The Indonesian wording in the mockups
  and in §7 is illustrative only. Only the **message content** is ID/EN.

## 7. Error handling

| Condition | Behaviour |
|---|---|
| Data age over the threshold, or never synced | Yellow banner in the list **and** the send dialog. Proceeding is allowed. |
| Sync running or failing | Toast "Sinkron sedang berjalan, coba 1 menit lagi" / "Gagal menghubungi Digiflazz". Old data is kept. |
| DM too long | Kirim is disabled with the reason: "Kurangi produk atau hapus foto (1.240/1.024)". |
| No ✅ items for DM | Kirim is disabled with "Tidak ada produk tersedia untuk dikirim". Copy is still allowed. |
| Selected item deleted or archived | The row is struck through with "Produk sudah tidak ada" and pruned from presets on save. |
| Clipboard API failure | A selected textarea appears with "Tekan lama → Salin". |
| Double click | Button locked plus idempotency key, so one post and one broadcast. |
| Scheduled send with nothing left | `CANCELLED` + reason + audit. No empty DM. |
| Re-render longer than the limit at send time | Cannot happen: re-resolve only drops items. This is asserted in tests. |

Invariants:

- The generator never writes stock, prices, product status or flash sales.
- Snapshots never contain credentials.
- No Telegram call from the web; delivery stays in the bot worker (AGENTS.md).

## 8. Testing

- **Renderer (unit)**:
  - 5 types × ID/EN × dm/channel
  - DM hides ⛔/🔧 items
  - channel collapses an all-sold-out product
  - available-first ordering
  - per-group split
  - HTML escaping of admin fields
  - button widths through `visualWidth`
  - Premium Apps never gets game wording or icons
  - `broadcastLength` matches the server rule
- **Snapshot (crud + DB)**: every row of the status mapping, the `markSoldOut` override, auto-deactivated versus admin-deactivated, GONE items, and data age from the new setting.
- **Worker**:
  - legacy rows still plain text (regression)
  - a generated row re-resolves and drops newly unavailable items
  - EN recipients get EN text
  - **call counts pinned**: exactly one `sendMessage` (or `sendPhoto`) per recipient, 0 edits, 0 deletes
  - all-unavailable means 0 sends + CANCELLED + audit
- **API**: permissions (readonly refused), idempotency on double submit, length validation equal to the client, audit sentences.
- **Client (RTL)**: per-type defaults, disabled-with-reason states, clipboard fallback, presets and "same as last", mobile sheet, and the old Restock/Maintenance templates replaced.
- **Gate**: `pnpm typecheck && pnpm test`, plus `pnpm doctor:bugs`, `pnpm doctor:full` with 0 errors and 0 warnings, and Storefront lint.

## 9. Rollout

1. Additive migration (two tables + back-relation). Run `prisma db push` / migrate **before** the new bot code runs.
2. Deploy order-bot and web-admin together. Legacy broadcasts are unaffected.
3. Set the footer and threshold in Settings.

## 10. Later phases (separate specs, in this order)

- **2a. DM opt-out + frequency cap.**
  - Inline buttons 🔕 Berhenti promo and ⚙️ Atur notif, plus `/berhenti` and `/notif`.
  - Three categories: Info stok, Promo, Pengumuman.
  - Caps: 1 promo/day and 3 DMs/week.
  - Applies to the existing automatic flash-sale and restock DMs too. Simultaneous flash sales are merged into one bubble.
  - Gangguan and Layanan Pulih are exempt from the cap.
- **2b. Prices + Flash Sale + Grosir.**
  - "mulai Rp…" per product. Resellers get the reseller price in DM, and the channel only ever shows the normal price.
  - Prices are recomputed at send time with the buyer's language and currency formatters.
  - **Flash Sale** reads only already-active flash sales. It is copy-for-channel only, because DMs are already automatic, and comes with a ready "flash sale berakhir" closing text.
  - **Grosir** DMs go to RESELLERS only. The channel gets a one-line teaser.
- **Later.** A price-history table, then **Update Harga** for price drops only.
- **Dropped:**
  - **Stok Terbatas**, because it conflicts with D8.
  - **Produk Dihentikan** as a type. A channel text preset under Pengumuman Umum covers it.
- **Admin guidance, not a feature:** at most 3–4 channel posts a day. Separate posts only for Flash Sale, Gangguan and Layanan Pulih.
