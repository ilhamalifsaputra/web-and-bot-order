# 06 — Network dan aliran data

## Referensi (OBSERVED terbatas)
Filter `api|graphql|_next/data|trpc` tidak menemukan request XHR pada halaman top-up Mobile Legends; 51 request statis. Gambar dimuat lewat endpoint optimasi gambar (`image?url=...`). INFERRED: halaman dirender dari server dengan data sudah tertanam. Tidak ada payload, token, atau cookie yang dicatat. Tidak ada API privat Gogogo yang dipanggil atau akan dipakai.

## Trustance (sumber kebenaran, OBSERVED dari kode)
| Kebutuhan | Endpoint | Berkas |
|---|---|---|
| Data home | `GET /api/v1/pages/home` | `apps/storefront/src/routes/apiPages.ts`, `pageData.ts:54` |
| Detail produk | `GET /api/v1/pages/product/:slug` | `pageData.ts:137` |
| Pencarian | `GET /api/v1/pages/search?q=` | `pageData.ts:277` |
| Cek nickname | `POST /api/v1/topup/check-account` | `routes/apiTopup.ts:541` |
| Preview harga | `POST /api/v1/topup/preview` | `apiTopup.ts:251` |
| Buat order | `POST /api/v1/topup/order` | `apiTopup.ts:284`, `createOrderDirect` `packages/db/src/crud/orders.ts:1100` |

Kontrak yang dipertahankan: klien tidak pernah mengirim harga; server menghitung ulang di transaksi.
