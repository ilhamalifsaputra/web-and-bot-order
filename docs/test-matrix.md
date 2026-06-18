# Test Matrix — audit gap closure (execution/10)

Baseline `npx vitest run`: **528 passed / 42 files** (deterministik — dijalankan
2× hijau). Naik dari 523; +5 test menutup gap audit F-01..F-04, L-9.

## Gap audit (F-01..F-04, L-9)

| ID | Gap | Status sebelumnya | Aksi task 10 | Lokasi |
|---|---|---|---|---|
| **F-01** | route `/search` query parsial & grup-by-name | name + empty + group-by-name **sudah ada** | **+1**: substring parsial (`contains` LIKE) | `storefront.test.ts` |
| **F-02** | voucher boundary | expired + used-up (sisi atas) **sudah ada** | **+2**: sisi bawah — 1 use tersisa & belum-kadaluarsa tetap berlaku | `voucher_application.test.ts` |
| **F-03** | wallet negatif (`allowNegative`) | overdraw-ditolak **sudah ada**; `allowNegative` **belum** | **+2**: `allowNegative` → saldo boleh negatif + ledger; guard exact ke 0 | `wallet.test.ts` |
| **F-04** | webhook `webhookCallback` | webhook mode + 401 bad-secret **sudah ada** | — (cukup; tercakup) | `apps/server/test/bootstrap.test.ts` |
| **L-9** | `logAdminAction` per route mutasi | ~15 action **sudah** diuji via tabel `auditLog` | **+1**: `wallet_adjust` (route uang yang belum di-assert) | `web.test.ts` |

## Coverage audit (L-9) — sudah luas

Action audit yang **sudah** ter-assert (via `prisma.auditLog`): `approve_order`,
`reject_order`, `order_credit_balance`, `category_create`, `group_create`,
`stock_upload`, `stock_bulk_delete`, `stock_download`, `stock_bulk_dead`,
`underpaid_deliver`, `outbox_retry`, `review_hide`, `product_bulk_active`,
`product_bulk_price`, `product_csv_import`, `broadcast_enqueue`, **+ `wallet_adjust`**.

Belum di-assert (route memang menulis audit di kode; kandidat lanjutan, satu
assertion per test happy yang sudah ada): `user_ban/unban/set_role`,
`voucher_create/toggle`, `ticket_close/reply`, `tx_*`, `web_admin_*`,
`branding_*`, `bulk_pricing_*`, `setting_*`, `group_update/delete`. Pola tinggal
diulang: query `auditLog` action+targetId setelah POST sukses.

## Matriks fitur × jenis test

| Flow | unit (crud) | route (`app.inject`) | edge/boundary |
|---|---|---|---|
| Register / login / 2FA | ✅ password/2fa | ✅ web.test auth | ✅ lockout |
| Katalog / denominasi | ✅ product_groups | ✅ `/c` `/g` `/p` | ✅ group collapse |
| **Search** | ✅ search parity (M-2) | ✅ name/empty/group | ✅ **partial (F-01)** |
| Checkout Bybit/QRIS/Binance | ✅ crud orders | ✅ handlers/conversations | ✅ collision refuse |
| **Voucher** | ✅ apply/createFromCart | — | ✅ **boundary both sides (F-02)** |
| **Wallet** | ✅ ledger/per-currency | ✅ adjust route | ✅ **allowNegative + zero (F-03)** |
| Webhook | — | ✅ **mode + 401 (F-04)** | ✅ bad secret |
| **Audit (L-9)** | ✅ logAdminAction | ✅ 17 action incl. **wallet_adjust** | — |

## Catatan

- Tak ada kode produksi diubah (murni penambahan test) — gap nyata yang ditutup
  (F-03 `allowNegative`, L-9 `wallet_adjust`) menguji perilaku yang sudah ada
  tapi belum terverifikasi.
- Determinisme: tak ada `Date.now()` boundary yang ketat tepat-di-titik (F-02
  pakai margin 60 dtk), jadi tak flaky; dikonfirmasi dengan 2× run hijau.
