# Plan: Perbaikan UX/UI Storefront + Web-Admin

Basis: `docs/audit-ui-ux-2026-06-21.md`. Eksekusi via subagent-driven development.

## Global Constraints (WAJIB dipatuhi semua task)

- **Jangan ubah perilaku/logika fungsional** — hanya layout, styling, struktur template. Form
  action, nama field, route, dan handler tetap.
- **Semua string customer/admin lewat `t(ctx, key, args)`** terhadap `packages/core/locales/{en,id}.json`.
  Bila menambah teks baru, tambahkan key ke **kedua** file dengan placeholder yang sama.
- **Pakai token desain** (`var(--pine)`, `var(--card)`, dst.) — jangan menambah warna hardcoded baru.
- **`pnpm typecheck` dan `pnpm test` harus tetap hijau.** Jalankan setelah perubahan.
- Pakai utilitas/komponen yang sudah ada (`.card`, `.btn`, `.field`, macro `_macros.njk`/`_shop.njk`).
- Edit hanya file yang disebut di task. Jangan refactor di luar scope.
- Commit setiap task dengan pesan jelas; akhiri pesan commit dengan
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Konteks teknis

- Storefront: `apps/storefront/views/*.njk`, CSS `apps/storefront/static/app.css`,
  layout `apps/storefront/views/base.njk` (body `min-h-screen flex flex-col`, `<main>` `py-8`).
- Admin: `apps/web-admin/views/*.njk`, CSS `apps/web-admin/static/app.css` + `admin-theme.css`.
- Tema bersama: `packages/web-ui/views/_theme.njk`.
- Pola center yang benar sudah ada di `apps/web-admin/views/login.njk:6`
  (`min-h-[70vh] flex items-center justify-center`).

---

## Task 1 — Login storefront muat 1 layar (HIGH)

**File:** `apps/storefront/views/login.njk` (utama). Selaraskan pola center yang sama ke
`apps/storefront/views/register.njk`, `forgot.njk`, `reset.njk`.

**Masalah:** form dibungkus `card card-pad max-w-md mx-auto py-10` di dalam `<main ... py-8>`,
tanpa centering vertikal → padding ganda + hero besar + widget → overflow di HP.

**Yang harus dilakukan:**
1. Bungkus konten login dalam container terpusat vertikal memakai **`svh`/`dvh`**, bukan `vh`
   (mis. `min-h-[calc(100svh-4rem)] flex items-center justify-center`; header storefront `h-16`=4rem).
   Tujuan: form muat tanpa scroll di 360×640 dan tidak geser saat keyboard mobile muncul.
2. Perkecil hero: ikon `w-10 h-10` → `w-8 h-8`, judul `text-2xl` → `text-xl`, rapatkan margin.
3. Hilangkan padding ganda (kurangi `py-10` kartu agar tidak menumpuk dengan `py-8` main).
4. Pertahankan SEMUA elemen fungsional: hidden `next`, field identifier+password, flash
   error/notice, tombol submit, link forgot/register, divider + widget Telegram (`bot_username`).
5. Untuk `register.njk`/`forgot.njk`/`reset.njk`: terapkan wrapper center yang sama (form lebih
   panjang boleh scroll jika perlu, tapi center & spacing konsisten).

**Verifikasi:** `pnpm typecheck`; jalankan test storefront jika ada (`pnpm -C apps/storefront test`
atau `pnpm test`). Catat secara manual: `/login` di viewport 360×640 muat tanpa scroll.

---

## Task 2 — Telegram di settings: framing + state terhubung lebih kaya (Medium)

**File:** `apps/storefront/views/settings.njk` (bagian section Telegram, baris ~42-62).

**Yang harus dilakukan:**
1. Saat **belum** tertaut (`{% else %}` cabang, widget di baris ~52): bungkus widget dalam
   wadah senada tema (padding, label "atau hubungkan dengan" via `t(...)`), agar tidak terlihat
   sebagai iframe tempelan.
2. Saat **sudah** tertaut (`tg_linked` true): tampilkan kartu status lebih kaya — ikon/centang +
   nama (`tg_name`) + (jika tersedia) tombol "Putuskan tautan". Jika tidak ada route unlink,
   cukup perbaiki tampilan status (jangan buat route baru — itu di luar scope).
3. Semua teks baru via `t(...)` di kedua locale.

**Catatan:** widget login.njk sudah ditangani di Task 1 (jangan sentuh login.njk di sini).

**Verifikasi:** `pnpm typecheck`; render settings (linked & unlinked) tidak menumpuk.

---

## Task 3 — Token desain: hilangkan hardcoded, tambah token radius (Medium, aman visual)

**File:** `apps/storefront/static/app.css`, `apps/web-admin/static/app.css`. (Jangan ubah
output visual — hanya ganti nilai literal jadi token; render harus identik.)

**Yang harus dilakukan:**
1. Ganti focus-ring/box-shadow `rgba(37,99,235,…)` → turunan token. Tambah variabel di `:root`:
   `--pine-rgb: 37 99 235;` lalu pakai `rgb(var(--pine-rgb) / .35)` dst. (atau `--ring`/`--ring-strong`).
   Lokasi storefront: `app.css:76` (`.btn:focus-visible`), `:90` (`.field:focus`), dan `body`
   gradient `:29`, `::selection :44`, `:focus-visible :45` (gunakan token yang sama bila rapi).
2. `.field { background:#fff }` (`app.css:88`) → `var(--card)`. Sama di admin app.css.
3. Tambah token radius di `:root` (`--r-sm:.5rem; --r-md:.75rem; --r-lg:1rem; --r-pill:9999px`)
   dan pakai di `.card`/`.btn`/`.field`/`.btn-sm`/`.chip` (nilai tetap sama, hanya via token).
4. Lakukan sepadan di kedua file agar tidak drift.

**Verifikasi:** `pnpm typecheck`; bandingkan render sebelum/sesudah harus sama persis.

---

## Task 4 — Touch target & overflow input (Low)

**File:** `apps/storefront/static/app.css` (+ admin app.css bila pola sama),
`apps/web-admin/views/product_detail.njk`.

**Yang harus dilakukan:**
1. Naikkan area sentuh minimum untuk aksi yang diketuk: `.btn-sm` & `.chip` beri tinggi efektif
   mendekati 40-44px (mis. naikkan padding-y) TANPA merusak layout tabel padat. Jika `.chip`
   banyak dipakai non-interaktif, batasi kenaikan hanya pada varian interaktif.
2. `product_detail.njk`: input ber-`min-w-[16rem]`/`min-w-[12rem]` → tambahkan `w-full min-w-0`
   pada input dan/atau `flex-wrap` pada container, agar tidak overflow horizontal di HP.

**Verifikasi:** `pnpm typecheck`; tidak ada overflow horizontal di product_detail pada lebar 360px.

---

## Penyelesaian

Setelah keemphat task lulus review + review akhir whole-branch: commit final (jika ada),
push branch `docs/audit-ui-ux`, lalu merge ke `master` dan push master.
