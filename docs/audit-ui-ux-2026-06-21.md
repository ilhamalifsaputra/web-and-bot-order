# Audit UX/UI — Storefront + Web-Admin

**Tanggal:** 2026-06-21
**Cakupan:** `apps/storefront` + `apps/web-admin` (berbagi `packages/web-ui/views/_theme.njk`).
**Sifat:** READ-ONLY — tidak ada kode yang diubah. Bot Telegram (grammY) di luar cakupan.
**Brief:** `auditUI.md`.

Setiap temuan: **Severity · File:baris · Penyebab · Dampak · Solusi**. Severity =
Critical / High / Medium / Low / Info. Disusun mengikuti 7 area pada brief.

> Catatan kejujuran audit: satu keluhan di brief ("avatar Telegram bentrok dengan
> widget di halaman settings") **tidak terbukti** di kode — `settings.njk` storefront
> sudah menyembunyikan widget saat akun tertaut. Lihat Area 3.

---

## Area 1 — Halaman Login (prioritas brief)

### 1.1 [HIGH] Login storefront tidak ter-center secara vertikal dan bisa overflow
- **File:** `apps/storefront/views/login.njk:7`; konteks `apps/storefront/views/base.njk:14,73`.
- **Penyebab:** form dibungkus `<div class="card card-pad max-w-md mx-auto py-10">` dan
  diletakkan di dalam `<main class="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">`. Body
  hanya `min-h-screen flex flex-col` — **tidak ada** `items-center`/centering vertikal.
  Akibatnya kartu mendarat di atas dengan **padding ganda** (`py-8` dari main + `py-10` dari
  kartu). Tinggi kartu juga ditambah hero besar (ikon `w-10 h-10`, judul `text-2xl`, hint),
  divider "atau", widget Telegram, dan baris forgot/register.
- **Dampak:** persis keluhan brief — di layar HP/pendek konten melebihi viewport sehingga
  perlu scroll hanya untuk melihat form utuh, dan halaman terasa "terlalu tinggi".
- **Solusi:**
  - Bungkus konten login dalam container terpusat, mis. `min-h-[100svh] flex items-center
    justify-center` (atau dikurangi tinggi header bila login memakai header).
  - Gunakan **`svh`/`dvh`**, bukan `vh`, agar layout tidak rusak saat keyboard mobile muncul
    / address bar berubah.
  - Perkecil hero (ikon `w-8 h-8`, judul `text-xl`), kurangi padding kartu, rapatkan spacing.
  - Pola referensi sudah ada di admin (lihat 1.2).

**Wireframe (target, mobile 360×640):**
```
┌──────────────────────────┐
│                          │  ← ruang fleksibel (center)
│        [ikon kecil]      │
│      Masuk ke Toko       │
│   hint singkat 1 baris   │
│  ┌────────────────────┐  │
│  │ Username/email     │  │
│  │ Password           │  │
│  │ [   Masuk   ]      │  │
│  │ Lupa?      Daftar  │  │
│  │ ── atau ──         │  │
│  │ [ Telegram login ] │  │
│  └────────────────────┘  │
│                          │  ← ruang fleksibel (center)
└──────────────────────────┘
        muat tanpa scroll
```

### 1.2 [INFO] Login admin sudah benar — jadikan acuan
- **File:** `apps/web-admin/views/login.njk:6` → `<div class="min-h-[70vh] flex items-center
  justify-center">` dengan kartu `max-w-sm`. Sudah ter-center, ringkas, tanpa widget berat.
- **Rekomendasi:** samakan pola storefront ke pendekatan ini (disesuaikan untuk `svh`).

---

## Area 2 — Responsive mobile / overflow horizontal

### 2.1 [MEDIUM] Input dengan `min-width` bisa memaksa overflow horizontal di HP
- **File:** `apps/web-admin/views/product_detail.njk` (input ber-`min-w-[16rem]` /
  `min-w-[12rem]`).
- **Penyebab:** `min-width` tetap (16rem ≈ 256px) di dalam baris yang tidak `flex-wrap` akan
  mendorong lebar melebihi viewport sempit.
- **Dampak:** scroll horizontal halus / layout "geser" di HP.
- **Solusi:** ganti ke `w-full` dengan `min-w-0` pada container flex, atau `flex-wrap` agar
  field turun baris di layar kecil.

### 2.2 [LOW] Tabel lebar — sudah dimitigasi, bisa ditingkatkan
- **File:** mis. `apps/web-admin/views/user_detail.njk` (riwayat wallet 6 kolom),
  `orders.njk`, `catalog.njk` — semua dibungkus `overflow-x-auto`.
- **Status:** *acceptable*. **Peningkatan:** di mobile, render sebagai daftar kartu
  (label–nilai) alih-alih tabel yang harus digeser.

### 2.3 [INFO] Storefront umumnya sehat secara tinggi
- Tidak ada pemakaian `100vh` bermasalah; footer menempel via `flex-1` (`base.njk:73`).
  Viewport meta benar (`base.njk:5`).

---

## Area 3 — Widget Telegram

### 3.1 [MEDIUM] Widget terasa "tempelan", tidak menyatu dengan design system
- **File:** `apps/storefront/views/login.njk:45`, `apps/storefront/views/settings.njk:52`.
- **Penyebab:** embed `telegram-widget.js` resmi adalah **iframe** milik Telegram — tidak
  bisa di-style. Radius (`data-radius="12"`), warna, dan shadow-nya tidak mengikuti token
  desain (kartu `1rem`, tombol `.75rem`, palet `--pine`).
- **Dampak:** elemen terlihat asing di tengah desain yang konsisten.
- **Solusi:** bungkus widget dalam container ber-card dengan label divider "atau lanjut
  dengan" yang konsisten; beri padding/`bg` agar membaur. (Iframe tetap tak bisa di-restyle
  internal, tapi framing-nya bisa dibuat senada.)

### 3.2 [INFO → KOREKSI BRIEF] "Avatar bentrok saat tertaut" tidak terjadi di settings
- **File:** `apps/storefront/views/settings.njk:44-61`.
- **Fakta:** widget berada di cabang `{% else %}` — hanya dirender saat **belum** tertaut.
  Saat `tg_linked` true, yang tampil hanya teks status "terhubung" (`settings.njk:45-48`),
  jadi tidak ada widget yang menumpuk dengan avatar. **Pola ini sudah benar.**
- **Kemungkinan sumber keluhan:** avatar/nama yang dirender **di dalam** widget login resmi
  pada `login.njk` setelah browser pernah mengotorisasi bot — itu rendering milik Telegram,
  bukan bug halaman. Solusinya tetap framing di 3.1.

### 3.3 [LOW] State "terhubung" di settings bisa lebih kaya
- **File:** `apps/storefront/views/settings.njk:45-48`.
- **Penyebab:** state linked hanya satu baris teks; tidak ada avatar, tidak ada tombol unlink.
- **Solusi:** kartu status: avatar (jika ada `photo_url`) + nama + tombol "Putuskan tautan".

---

## Area 4 — Konsistensi desain

### 4.1 [MEDIUM] Token desain terduplikasi & drift antar app
- **File:** sumber `packages/web-ui/views/_theme.njk`; duplikat penuh di
  `apps/storefront/static/app.css:4-24` dan `apps/web-admin/static/app.css` (blok `:root`
  sama persis); ditambah `apps/web-admin/static/admin-theme.css` yang meng-override font
  (Inter) dan palet (slate).
- **Penyebab:** token dideklarasikan di banyak tempat tanpa satu sumber kebenaran.
- **Dampak:** mengubah satu warna butuh edit di ≥3 berkas; admin dan storefront sebenarnya
  "drift" walau katanya berbagi tema.
- **Solusi:** satukan token ke `_theme.njk`; biarkan tiap app hanya meng-override yang memang
  beda secara sengaja (mis. font admin) lewat variabel, bukan menyalin seluruh blok.

### 4.2 [MEDIUM] Nilai warna hardcoded, bukan token
- **File:** `apps/storefront/static/app.css:76` (`box-shadow: ... rgba(37,99,235,.35)` pada
  `.btn:focus-visible`), `:90` (`.field:focus ... rgba(37,99,235,.2)`), `:88`
  (`.field { background:#fff }` — seharusnya `var(--card)`); pola serupa di admin
  `app.css` & tab.
- **Dampak:** mengganti warna primer/kartu tidak terbawa ke focus-ring & background field.
- **Solusi:** ganti `rgba(37,99,235,…)` → turunan `var(--pine)`; `#fff` → `var(--card)`.

### 4.3 [LOW] Skala border-radius tidak konsisten
- **File:** `app.css` — card `1rem` (`:67`), btn/field `.75rem` (`:75,88`), btn-sm `.5rem`
  (`:85`), chip `9999px` (`:108`), code `.25rem` (`:107`).
- **Solusi:** tetapkan token radius (`--r-sm/.5`, `--r-md/.75`, `--r-lg/1rem`, `--r-pill`) dan
  pakai konsisten.

### 4.4 [LOW] Scrollbar hanya didefinisikan di app.css, bukan theme bersama
- **File:** `apps/storefront/static/app.css:34-41` — gaya scrollbar tak ikut `_theme.njk`,
  jadi tidak portabel bila app ketiga memakai tema tanpa app.css.

---

## Area 5 — Mobile-first UX / touch target

### 5.1 [LOW] Beberapa target sentuh di bawah ~44px
- **File:** `.chip` `padding:.125rem .625rem` (`apps/storefront/static/app.css:108`),
  `.btn-sm` ~24px tinggi (`:85`).
- **Dampak:** sulit ditekan akurat di HP bila dipakai sebagai aksi utama.
- **Solusi:** untuk aksi yang bisa diketuk, naikkan area sentuh (min ~40-44px), atau pastikan
  chip/btn-sm hanya untuk aksi sekunder yang berjarak cukup.

### 5.2 [MEDIUM] Login + keyboard mobile
- Bergantung pada Area 1: dengan `svh/dvh` + centering, fokus input tidak menggeser layout.

---

## Area 6 — Hierarki visual / kepadatan

### 6.1 [MEDIUM] Settings admin terlalu padat
- **File:** `apps/web-admin/views/settings.njk` (5 tab + banyak kartu payment bertumpuk:
  TokoPay/PayDisini/NOWPayments/Bybit/Binance, masing-masing toggle + beberapa field).
- **Dampak:** scroll panjang di HP, sulit dipindai.
- **Solusi:** pisah jadi sub-halaman per domain, atau collapse/accordion per metode payment;
  tampilkan ringkasan status di atas.

### 6.2 [LOW] Grid 3 kolom menyempit di tablet
- **File:** `apps/web-admin/views/order_detail.njk`, `user_detail.njk` (`lg:grid-cols-3`).
- **Solusi:** turunkan ke 1-2 kolom di rentang tablet sebelum `lg`.

### 6.3 [LOW] Home storefront sangat panjang
- **File:** `apps/storefront/views/home.njk` (335 baris: hero, features, categories,
  featured, testimonials, FAQ, contact).
- **Solusi:** tinjau jumlah section/card & white space agar tidak terasa ramai; pertimbangkan
  memangkas section yang kurang esensial di atas lipatan.

---

## Area 7 — Ringkasan temuan

| # | Severity | Area | File:baris | Solusi singkat |
|---|----------|------|-----------|----------------|
| 1.1 | **HIGH** | Login | `storefront/views/login.njk:7` | Center `svh/dvh` + perkecil hero + kurangi padding |
| 1.2 | Info | Login | `web-admin/views/login.njk:6` | Acuan pola center yang benar |
| 2.1 | Medium | Responsive | `web-admin/views/product_detail.njk` | `w-full`+`min-w-0`/`flex-wrap` |
| 2.2 | Low | Responsive | `web-admin/views/user_detail.njk` (+tabel lain) | Card-list di mobile |
| 3.1 | Medium | Telegram | `storefront/views/login.njk:45`, `settings.njk:52` | Framing card senada tema |
| 3.2 | Info | Telegram | `storefront/views/settings.njk:44` | Klaim brief tak terbukti (sudah benar) |
| 3.3 | Low | Telegram | `storefront/views/settings.njk:45` | Kartu status + avatar + unlink |
| 4.1 | Medium | Konsistensi | `_theme.njk` + 2×`app.css` + `admin-theme.css` | Satu sumber token |
| 4.2 | Medium | Konsistensi | `storefront/static/app.css:76,88,90` | Hardcoded → `var()` |
| 4.3 | Low | Konsistensi | `storefront/static/app.css:67,75,85,108` | Token radius |
| 4.4 | Low | Konsistensi | `storefront/static/app.css:34` | Pindah scrollbar ke theme |
| 5.1 | Low | Touch | `storefront/static/app.css:85,108` | Naikkan area sentuh |
| 5.2 | Medium | Touch | (lihat 1.1) | `svh/dvh` saat keyboard |
| 6.1 | Medium | Hierarki | `web-admin/views/settings.njk` | Pisah/accordion |
| 6.2 | Low | Hierarki | `web-admin/views/order_detail.njk`, `user_detail.njk` | Kurangi kolom di tablet |
| 6.3 | Low | Hierarki | `storefront/views/home.njk` | Pangkas section/white space |

**Prioritas eksekusi (dirinci di rencana perbaikan):**
1. **P1 (High):** Login storefront fit 1 layar (1.1, 5.2).
2. **P2 (Medium):** Framing Telegram widget + status linked kaya (3.1, 3.3).
3. **P3 (Medium):** Konsolidasi token + hardcoded→var (4.1, 4.2).
4. **P4 (Low):** Touch target, overflow input, kepadatan settings (2.1, 5.1, 6.1).
