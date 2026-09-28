# Audit UI/UX Struktural — Admin Panel (`apps/web-admin/client`)

**Tanggal:** 2026-07-24
**Cakupan:** `apps/web-admin/client/src/pages/*` (27 halaman) — konformansi struktural/
Information Architecture terhadap pola referensi `OrdersPage.tsx`, bukan bug visual atau fitur
yang hilang.
**Sifat:** READ-ONLY — audit ini tidak mengubah kode aplikasi apa pun. Ini adalah Fase 0 dari
sebuah rangkaian sesi redesign; implementasi per halaman dilakukan di sesi terpisah setelah
dokumen ini.
**Fokus:** apakah setiap halaman list/index mengikuti hierarki wajib
`docs/ui/04_CRUD_TEMPLATE.md` — PageHeader → KPI row (opsional) → Toolbar (FilterBar+
SearchBar) → bulk-action bar (kondisional) → DataTable → Pagination — dan aturan komponen di
`05_TABLE_GUIDELINES.md`/`10_UI_REVIEW_CHECKLIST.md`. Ini **bukan** audit "apakah fitur X ada",
itu domain dokumen lain.

> Audit ini melengkapi, bukan mengulang, dua dokumen yang sudah ada:
> - `docs/admin-ux-pass-v2-plan.md` — gap **fungsional** (CSV export, Add Category, toggle
>   switch aktif/nonaktif, lastSeenAt/totalSpent di kolom Customers, ticket assign, dll).
> - `docs/audit-ui-ux-2026-06-21.md` / `docs/audit-ui-ux-functional-2026-07-01.md` — perilaku
>   yang **rusak atau menyesatkan** (tombol ke endpoint salah, error yang ditelan diam-diam).
>
> Beberapa halaman muncul di lebih dari satu dokumen; di setiap kasus itu, bagian temuan di
> bawah menyebutkan secara eksplisit apa yang sudah dicakup dokumen lain supaya tidak ada
> pekerjaan yang direncanakan dua kali. Satu catatan penting: `admin-ux-pass-v2-plan.md`
> mengasumsikan kartu statistik Payments "computed client-side from the already-fetched
> transaction list" sudah cukup — audit ini menemukan itu **bukan cuma soal sumber data, tapi
> bug korektnes** begitu halaman itu dipaginasi (lihat §Payments di bawah). Item itu perlu
> ditangani ulang, bukan sekadar "sudah beres".

---

## 1. Rubrik referensi (ringkasan)

**Pola penuh (`OrdersPage.tsx`, "full tier")** — dipakai untuk daftar besar/berkembang:

```
PageHeader (title + description + primary action di slot `actions`)
  → KPI row (StatCard/StatTile) [opsional tapi direkomendasikan]
  → Toolbar: FilterBar membungkus SearchBar + Select/DateInput filter
  → Bulk-action bar — HANYA render saat selected.size > 0, sticky, tidak pernah permanen
  → DataTable (tidak pernah <table> mentah)
  → Pagination — hanya untuk halaman server-paginated
```

**Pola sederhana ("simple tier")** — untuk daftar kecil (mis. Admins, Denominations): filter
langsung client-side, tanpa pagination, tanpa bulk actions. **Tidak ada yang salah** jika
halaman simple-tier memang tidak punya Pagination/bulk actions — itu sesuai desain, bukan gap.
Audit di bawah hanya menandai "tidak ada Pagination" sebagai gap ketika datasetnya realistis
bisa tumbuh besar (mis. Vouchers, Users, Payments, StockProduct credentials), bukan untuk daftar
yang secara inheren kecil (Admins, kategori).

Elemen lain yang wajib menurut `05_TABLE_GUIDELINES.md`/`10_UI_REVIEW_CHECKLIST.md`:
- Empty state selalu lewat komponen `EmptyState` (icon+headline+subline+action), **tidak
  pernah** teks mentah seperti `<div>No data</div>`.
- Selection state (bulk) selalu dimiliki halaman (`Set<id>`), bukan di dalam `DataTable`.
- Row actions lewat `DropdownMenu` dengan `stopPropagation()`, bukan tombol lepas per kolom.
- Pagination memakai komponen `Pagination` bersama — tidak boleh Prev/Next buatan sendiri per
  halaman.
- `PageHeader` selalu sibling dari isi halaman lainnya, bukan nested dalam wrapper `gap-*` yang
  sama.

Halaman detail (mis. `OrderDetailPage`) dan halaman form/settings (mis. `SettingsPage`) memakai
pola yang **berbeda dan sah** (`06_SETTINGS_GUIDELINES.md`) — sebagian besar elemen di atas
memang tidak berlaku untuk mereka by design, dan itu bukan gap.

---

## 2. Temuan per halaman

### 2.1 Halaman List/Index (pola referensi berlaku penuh)

| Halaman | PageHeader+desc | Primary action | KPI row | FilterBar | SearchBar | Bulk actions | DataTable | Pagination | Empty state |
|---|---|---|---|---|---|---|---|---|---|
| **PaymentsPage** | Judul saja, tanpa deskripsi | Tidak ada (Manual Match cuma form) | Ada, tapi `Card` biasa (bukan `StatTile`) **dan dihitung dari data 1 halaman saja** | Ada (filter outcome) | Tidak ada | Tidak ada | Ya (3 tabel terpisah: underpaid/pending-internal/ledger) | Prev/Next buatan sendiri, bukan komponen `Pagination` | `EmptyState` dipakai dengan baik |
| **CatalogPage** | Ada, lengkap | Ada ("Add Product" + 2 aksi sekunder) | Ada, via `StatTile` | Ada | Ada | Ada, lengkap (checkbox + sticky bar) | Ya | **Tidak ada** — seluruh daftar produk diambil tanpa paginasi | Dua empty state berbeda (filtered vs kosong asli), bagus |
| **VouchersPage** | Judul saja | Ada (inline create form) | Tidak ada | Ada (filter status) | **Tidak ada** (tidak bisa cari by kode) | **Tidak ada** | Ya | **Tidak ada** | Dua empty state berbeda, bagus |
| **StockProductPage** | Ada + breadcrumb, tanpa deskripsi | Ada (Download credentials, kontekstual) | Ada, tapi teks inline biasa (bukan `StatTile`/`Card`) | Tidak ada (pakai `Tabs` Available/Sold/Dead — pola alternatif yang wajar) | Tidak ada | Ada, lengkap (checkbox + sticky bar per tab) | Ya (per tab) | **Tidak ada** — berisiko untuk daftar kredensial besar | Ada, layak |
| **UsersPage** | Judul saja | Tidak ada | Tidak ada | Ada | Ada (submit-gated, bukan live) | Tidak ada | Ya | **Tidak ada** — berisiko untuk daftar customer besar | Ada tapi dasar (tanpa action) |
| **AdminsPage** | Judul saja | Form "Add Admin" nyatu di dalam FilterBar, bukan aksi header terpisah | Tidak ada | Ada, tanpa filter nyata | Tidak ada | Tidak ada | Ya | Tidak ada (wajar — daftar admin kecil) | Icon+title saja, tanpa deskripsi/aksi |
| **SupportPage** | Judul saja | Tidak ada | Tidak ada | Ada (filter status) | **Tidak ada** | Tidak ada | Ya | Tidak ada | Icon+title+deskripsi, cukup baik |
| **ReviewsPage** | Judul saja | Tidak ada | Tidak ada | Ada (filter hidden/visible) | Tidak ada | Tidak ada | Ya | Ada | Icon+title+deskripsi, bagus |
| **ReportsPage** | Ada (Export CSV sebagai aksi header) | Ada (Export CSV) | Tidak ada — pakai `Card` ad-hoc, bukan `StatCard` | **Tidak ada sama sekali** — periode 30-hari statis, tidak bisa difilter | Tidak ada | Tidak ada | Ya (3 sub-tabel) | Tidak ada | Title-only di tiap sub-bagian, tanpa icon/deskripsi |
| **AuditPage** | Judul saja | Tidak ada | Tidak ada | Ada (beberapa filter Input/DateInput) | **Tidak ada** | Tidak ada | Ya | **Prev/Next buatan sendiri**, bukan komponen `Pagination` | **`<div>No audit entries found.</div>` mentah — bukan `EmptyState`** |
| **OutboxPage** | Judul saja | Tidak ada | Ada, tapi pill teks biasa (bukan `StatCard`) | Ada (filter status) | **Tidak ada** | Tidak ada | Ya | **Prev/Next buatan sendiri**, bukan komponen `Pagination` | Ada, layak (icon+title+deskripsi) |
| **SearchPage** | Judul saja | Input+Button polos, bukan `FilterBar`/`SearchBar` | Tidak ada | **Tidak memakai `FilterBar`/`SearchBar` sama sekali** — pola struktural berbeda | — (lihat kolom FilterBar) | Tidak ada | Ya (2 tabel: users/products) | Tidak ada | Sub-tabel produk **tidak punya prop `empty` sama sekali**; kasus "no results" title-only |

**Catatan silang dengan dokumen lain:**
- **PaymentsPage**: `admin-ux-pass-v2-plan.md` §Phase 2 merencanakan kartu statistik
  "computed client-side from the already-fetched transaction list — no new route", dengan
  asumsi implisit itu sudah cukup benar. Audit ini menemukan implementasinya memang
  client-side, tapi **hanya dari baris di halaman saat ini** — begitu ledger dipaginasi,
  "Today's Transactions" jadi salah diam-diam. Saat sesi redesign Payments dikerjakan, hitung
  statistik dari agregat server (atau minimal dari seluruh dataset yang difilter, bukan
  potongan halaman), bukan cuma menambahkan `StatTile`.
- **VouchersPage**: `admin-ux-pass-v2-plan.md` §Phase 2 merencanakan copy-to-clipboard,
  highlight "akan kedaluwarsa", dan filter status turunan client-side — ini fitur berbeda
  dimensi dari gap struktural (search/bulk/KPI/pagination) yang ditemukan di sini. Keduanya
  cocok dikerjakan dalam sesi yang sama karena menyentuh file yang sama.
- **SupportPage**: `admin-ux-pass-v2-plan.md` mencatat "Status filter: … just needs a
  `FilterBar` control wired to it" seolah belum ada — audit ini menemukan `FilterBar` **sudah**
  punya `Select` status saat ini. Kemungkinan sudah dikerjakan sejak v2-plan ditulis; verifikasi
  ulang saat mulai sesi Support, jangan asumsikan dari salah satu dokumen saja.
- **AuditPage**: `admin-ux-pass-v2-plan.md` mencatat filter Audit Log "already shipped" — itu
  benar dan tidak dibantah di sini. Gap yang ditemukan audit ini (empty state mentah,
  pagination buatan sendiri) adalah dimensi berbeda dari filter, tidak tumpang tindih.
- **UsersPage**: `admin-ux-pass-v2-plan.md` §Phase 2 merencanakan penambahan kolom
  `lastSeenAt`/`totalSpent`. Itu independen dari gap struktural di sini (pagination, KPI row,
  bulk actions) — keduanya cocok satu sesi karena sama-sama menyentuh `UsersPage.tsx`.

### 2.2 Halaman Detail (pola referensi sebagian besar tidak berlaku by design)

Halaman-halaman ini secara wajar tidak punya FilterBar/SearchBar/bulk actions/KPI
row/Pagination — itu bukan gap, itu desain yang benar untuk halaman detail satu entitas.
Berikut catatan untuk kekurangan **genuine** yang tetap ditemukan:

- **ProductDetailPage** — selaras dengan peran detail; empty state layak.
- **OrderDetailPage** — empty state untuk daftar item cuma `title`, tanpa icon/deskripsi
  (satu-satunya empty state paling minimal di antara semua halaman yang diaudit). Perbaikan
  kecil, low-effort.
- **UserDetailPage** — dua `DataTable` (order history, wallet ledger) sama-sama punya empty
  state title-only tanpa icon/deskripsi — perbaikan kecil yang sama.
- **StockProductPage** (peran detailnya) — sudah dibahas di §2.1 karena juga berfungsi sebagai
  daftar (tabs Available/Sold/Dead dengan bulk actions penuh).
- **TicketDetailPage** — pola thread/percakapan, bukan tabel; tidak ada elemen referensi yang
  relevan, tidak ada gap.

### 2.3 Halaman Form/Settings (pola `06_SETTINGS_GUIDELINES.md`, bukan pola list)

Semua halaman ini **sudah sesuai** pola form/settings yang benar — tidak ada rekomendasi
perubahan struktural:

- **SettingsPage** — contoh terbaik: `PageHeader` dengan dropdown quick-actions,
  `SettingsHealthCard` sebagai ringkasan status ala-KPI, nav kiri sticky + search, tiap field
  inline-edit dengan `SaveConfirmDialog` sebelum mutasi jalan.
- **StoragePage** — juga contoh baik: `PageHeader` dengan deskripsi, `StatCard` sungguhan
  (pemakaian folder + ukuran DB), `ConfirmDialog` untuk aksi destruktif.
- **BrandingPage** — mengikuti konvensi inline-edit yang sama, wajar untuk cakupannya yang
  lebih kecil.
- **ProductCreatePage, DenominationCreatePage, DenominationEditPage** — form murni,
  `PageHeader`+breadcrumb, tidak ada yang hilang untuk peran mereka.

### 2.4 Dashboard

`DashboardPage.tsx` sendiri sudah mengikuti urutan komposisi yang diwajibkan
`docs/ui/07_DASHBOARD_GUIDELINES.md` (`PageHeader` → `KpiRow` → `OperationCenter` → …).
**Catatan penting:** audit ini hanya membaca `DashboardPage.tsx` itu sendiri, **tidak**
menyelami widget anak-anaknya (`BusinessHealthGrid`, `SalesAnalyticsCard`,
`RecentOrdersTable`, dll). `07_DASHBOARD_GUIDELINES.md` sendiri sudah mencatat
`RecentOrdersTable` sebagai utang teknis (masih `<table>` mentah, bukan `DataTable`). Jika user
ingin Dashboard benar-benar diaudit/didesain ulang, itu perlu sesi eksplorasi tersendiri yang
menyelami tiap widget — di luar cakupan audit struktural halaman-list ini.

---

## 3. Backlog terprioritaskan

| Prioritas | Halaman | Gap utama | Kelompok sesi yang disarankan |
|---|---|---|---|
| **P0** | Payments | Kartu statistik salah begitu ledger dipaginasi (bug korektnes, bukan cuma kosmetik) | Satu sesi bersama gap P1 Payments di bawah |
| **P1** | Vouchers | Tanpa search, bulk actions, KPI row, pagination | Sendiri |
| **P1** | Payments | Tanpa search/bulk actions, kartu statistik bukan komponen bersama, pagination buatan sendiri, 3 tabel sejajar yang tidak biasa | Sendiri (gabung dengan P0 di atas) |
| **P1** | Search | Tidak memakai `FilterBar`/`SearchBar` sama sekali (pelanggaran struktural), satu sub-tabel tanpa prop `empty` | Sendiri |
| **P1** | Audit + Outbox | Pagination buatan sendiri (Prev/Next) alih-alih komponen `Pagination` bersama; Audit juga pakai `<div>` mentah alih-alih `EmptyState` | Satu sesi gabungan — perbaikannya adalah swap komponen yang sama di kedua halaman |
| **P2** | Catalog | Hanya kekurangan `Pagination` — selebihnya sudah paling lengkap di antara semua halaman | Sendiri, low-effort |
| **P2** | StockProduct | Tanpa filter/search dalam tab (pola `Tabs` sudah wajar sebagai pengganti), tanpa pagination untuk daftar kredensial yang bisa besar, statistik teks polos | Sendiri |
| **P2** | Users | Tanpa pagination, KPI row, bulk actions, deskripsi header | Gabung dengan item `lastSeenAt`/`totalSpent` dari `admin-ux-pass-v2-plan.md` |
| **P2** | Support | Tanpa search, pagination, KPI row, bulk actions | Sendiri (verifikasi ulang status filter dulu — lihat catatan silang §2.1) |
| **P2** | Admins | Tanpa pagination, search; empty state lemah; aksi utama menyatu di FilterBar | Sendiri, low-effort |
| **P2** | Reports | Tanpa KPI/StatCard row, tanpa filter sama sekali, empty state title-only | Sendiri — sifatnya lebih halaman analitik, sebagian gap memang wajar, tapi empty state tetap perlu diperbaiki |
| **P2** | Reviews | Paling dekat dengan standar — hanya kurang SearchBar, KPI row, bulk actions, deskripsi | Sendiri, low-effort |
| **P3** | Semua halaman detail (§2.2), semua halaman form/settings (§2.3) | Tidak ada aksi diperlukan | — |
| **Follow-up terpisah** | Dashboard widget anak-anak | Belum diaudit dalam pass ini | Sesi eksplorasi tersendiri jika diminta |

---

## 4. Pendekatan eksekusi yang disarankan

Setiap baris di atas (atau kelompok yang sudah digabung) dikerjakan sebagai **sesi terpisah**,
dijalankan lewat `superpowers:subagent-driven-development` sesuai `CLAUDE.md`, masing-masing
diakhiri dengan:

```bash
pnpm typecheck
pnpm test
pnpm --filter @app/web-admin-client build
```

ditambah pengecekan manual di browser (`pnpm dev:web`) mengikuti bagian "Final check" pada
`docs/ui/10_UI_REVIEW_CHECKLIST.md` — pola yang sama seperti yang sudah dipakai
`docs/admin-ux-pass-v2-plan.md` untuk fase-fasenya.

Urutan yang disarankan: mulai dari P0/P1 (Payments+Vouchers+Search+Audit/Outbox) karena
dampaknya paling besar dan/atau memperbaiki bug nyata, baru lanjut ke P2 satu per satu.
