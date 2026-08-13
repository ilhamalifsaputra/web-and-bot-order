# Evaluasi Storefront — 9 Agustus 2026

Hasil pengujian end-to-end `apps/storefront` memakai Playwright (Chromium) di
`http://127.0.0.1:8110`, commit `2b95e1b`. Alur yang ditelusuri: login →
register → forgot/reset → home → katalog → produk → cart → checkout (tamu) →
track order → area akun (orders, settings, referral, reviews, support/tiket) →
halaman statis → 404 → viewport mobile.

Cakupan: alur & fungsi (§2–4), **animasi/motion (§5)**, **tampilan visual &
kontras (§6)**, **empty state (§7)**, dan **tampilan ulasan saat ada isinya
(§8)**.

Semua temuan di bawah **sudah diverifikasi di browser** — timing animasi diukur
per frame, CLS lewat `PerformanceObserver`, kontras dihitung dengan rumus
WCAG — dan yang menyangkut kode sudah dicek sampai `file:baris`. Screenshot
bukti ada di `storefront-eval-shots/`.

---

## 0. Catatan setup (bukan bug aplikasi)

DB dev lokal (`data/bot.db`) tertinggal **8 migrasi**. Akibatnya setiap request
yang membawa cookie sesi langsung 500 — persis kasus P2022 yang ditulis di
`CLAUDE.md`:

```
The column `main.users.is_guest` does not exist in the current database.
  at optionalCustomer (apps/storefront/src/plugins/auth.ts:38)
```

`prisma migrate deploy` gagal (`P3018 — duplicate column name: customer_data`)
karena DB ini sebelumnya pernah disinkron lewat `db push`, jadi riwayat migrasi
tidak cocok. Yang berhasil:

```bash
pnpm exec prisma db push --skip-generate
```

`migrate diff` sudah dicek dulu sebelum dijalankan — perubahannya hanya
menambah `users.is_guest`, `users.guest_email`, dan
`notification_outbox.channel`; semua kolom lama ikut disalin, **tidak ada data
yang hilang**. Backup DB sebelum perubahan tersimpan di direktori tmp job
(`bot.db.backup-20260809-003003`).

> Catatan penting: riwayat migrasi DB dev ini sekarang tetap "drifted" (8 migrasi
> masih tercatat belum diterapkan walau kolomnya sudah ada). Untuk dev lokal
> tidak masalah, tapi **jangan** pakai `db push` di produksi — di sana urutan
> migrasi harus dibereskan dulu dengan `prisma migrate resolve`.

**Metode pembayaran belum dikonfigurasi** di DB dev ini, jadi checkout tidak
bisa diselesaikan sampai order jadi. Yang **belum** teruji karena itu: halaman
`/checkout/:code/pay`, detail order, dan pengiriman kredensial. Sisanya
tercakup semua.

---

## 1. Yang sudah bagus

Ini bukan basa-basi — beberapa bagian kualitasnya di atas rata-rata dan
sebaiknya jangan diutak-atik saat memperbaiki yang lain.

**Aksesibilitas drawer mobile — nyaris sempurna.** `role="dialog"`,
`aria-modal="true"`, `aria-expanded` yang ikut berubah, fokus pindah ke tombol
tutup saat dibuka, Escape menutup, dan **fokus kembali ke tombol pemicu**.
Implementasi dialog yang benar-benar sesuai buku.

**Guest checkout & track order.** Copy-nya jelas soal konsekuensi ("simpan kode
pesanan, karena kode itu plus email ini satu-satunya cara masuk lagi"). Error
`/track` aman dari enumerasi — pesan generik yang sama untuk kode salah maupun
email salah, plus contoh format `ORD-20260101-ABCD` dan jalan keluar (Telegram,
Masuk).

**Penanganan stok.** Badge "Sisa 3" muncul di kartu dan halaman produk,
`max` pada input qty ikut stok (dicoba isi 99 → langsung dipotong jadi 3), dan
produk habis mengganti tombol beli dengan "Notify me when ready" — bukan tombol
mati tanpa penjelasan.

**Escaping XSS.** `/search?q=<img src=x onerror=alert(1)>` dirender sebagai teks
biasa; tidak ada elemen yang ter-inject.

**Empty state di mana-mana.** Cart kosong, hasil pencarian nihil (lengkap dengan
saran ejaan + riwayat pencarian + dua CTA), belum ada pesanan, belum ada ulasan,
belum ada tiket, flash sale kosong — semuanya digarap, tidak ada halaman kosong
melompong.

**Atribut form benar.** `autocomplete` (`name`, `username`, `email`,
`new-password`), `pattern` username, `minlength`, `inputmode="email"`. Nilai
form **tetap dipertahankan** saat submit gagal.

**Cart tamu ikut pindah** ke akun setelah register — 3 item tetap utuh.

**Komposer tiket** punya template terisi ("Nomor pesanan: / Produk: / Apa yang
terjadi: / Kapan terjadi:"), chip balasan cepat, penghitung 0/2000, dan hint
Ctrl/Cmd+Enter.

**i18n luas dan rapi.** Ganti bahasa mengubah `<html lang>`, `<title>`, dan
seluruh isi halaman termasuk checkout. Shell server juga merender h1/h2 asli
untuk SEO. (Satu pengecualian penting — lihat temuan #1.)

**Status code benar.** 404 asli untuk rute tak dikenal (bukan 200), header dan
footer tetap ada, terjemahan ikut.

Performa muat awal wajar: 388 KB total, 13 request, DOMContentLoaded 91 ms
(localhost).

---

## 2. Temuan prioritas tinggi

### T1. Chip status pesanan & tiket tidak ikut bahasa (hardcoded Inggris)

`apps/storefront/client/src/components/shop/StatusBadge.tsx:9-32` menyimpan label
sebagai string Inggris mati. Komentar di file itu mengakuinya secara eksplisit:

> *"The macro's labels are plain English words hardcoded in the NJK itself (no
> `t()` call, so they don't change with `lang`) — ported verbatim"*

Padahal `TicketStatusBadge.tsx` (dipakai di halaman detail tiket) **memakai
`t()`** dan diterjemahkan.

Akibatnya satu tiket yang sama tampil beda di dua layar dalam satu alur:

| Layar | Yang tampil |
|---|---|
| `/account/support` (daftar) | `Open` |
| `/account/support/5` (detail) | `Menunggu Dukungan` |

Ini terverifikasi langsung di browser. Dampaknya luas — chip yang sama dipakai
di `/account/orders`, detail order, daftar tiket, dan badge stok. Untuk toko yang
default-nya bahasa Indonesia, status pesanan adalah salah satu hal yang paling
sering dibaca pembeli.

**Saran:** pindahkan label `StatusBadge` ke kunci `t()` seperti
`TicketStatusBadge`, lalu tambahkan entri di `packages/core/locales/{id,en}.json`.

### T2. `document.title` tidak pernah berubah saat navigasi client-side

Grep di seluruh `apps/storefront/client/src/` menemukan **nol** penulisan
`document.title` — judul hanya diset sekali oleh shell server saat load pertama.

Terbukti di browser: dari `/p/youtube` klik "Add to cart" → URL jadi `/cart`,
judul tab tetap `YouTube — Toko Digital`. Dari home ke `/terms`, judul tetap
judul home.

Dampak: judul tab salah, bookmark salah, riwayat browser salah, dan pengguna
screen reader tidak mendapat pengumuman perpindahan halaman.

**Saran:** hook `useDocumentTitle(title)` per halaman, atau satu efek di
`Layout` yang memetakan rute → judul (sumbernya sudah ada di shell server).

### T3. Posisi scroll tidak di-reset saat pindah rute

Tidak ada `ScrollRestoration` maupun `window.scrollTo` pada perubahan lokasi di
`App.tsx` / `PageTransition.tsx` / `Layout.tsx`.

Terbukti: scroll home ke y=1500 → klik "Kebijakan Privasi" di footer → mendarat
di **y=405**, bukan di atas. Pengguna sampai di halaman baru dalam keadaan sudah
ter-scroll ke tengah. Karena semua link kebijakan ada di footer (yang baru
kelihatan setelah scroll jauh), ini kena hampir setiap kali.

**Saran:** pakai `<ScrollRestoration />` dari react-router v7, atau
`useEffect(() => window.scrollTo(0, 0), [pathname])`.

---

## 3. Temuan prioritas menengah

### T4. Link reset password baru divalidasi saat submit

`/reset/<token-ngawur>` tetap merender form "Buat kata sandi baru" lengkap.
Pengguna mengisi password dua kali, menekan Simpan, **baru** muncul: *"Tautan
reset ini tidak valid atau kedaluwarsa — minta yang baru."*

Dua masalah sekaligus:
1. Usaha pengguna terbuang; token seharusnya divalidasi saat halaman dimuat.
2. Pesannya menyuruh "minta yang baru" **tanpa menyediakan link ke `/forgot`** —
   jalan buntu.

### T5. Registrasi berhasil tanpa konfirmasi apa pun

Setelah "Buat akun" sukses, pengguna dilempar ke homepage tanpa toast, tanpa
salam, tanpa penanda apa pun. Satu-satunya petunjuk bahwa akun jadi dan sudah
login adalah label header berubah dari "Masuk" jadi "Akun" — mudah terlewat.

### T6. Halaman `/account` mengulang konten yang sama sampai tiga kali

Empat kartu statistik di atas (Pesananku, IDR Credit Balance, Referral, USDT
Credit Balance) diulang lagi di bawah oleh panel "Ringkasan saldo" (IDR + USDT)
dan kartu "Referral" (kode yang sama). Tiga tile "Aksi cepat" (Ulasanku,
Pengaturan, Bantuan) juga muncul lagi sebagai baris di daftar navigasi tepat di
bawahnya. Halaman jadi jauh lebih panjang dari yang perlu. Lihat
`storefront-eval-shots/08-account.png`.

### T7. Satu bundle JS 183 KB, tanpa code splitting per rute

Seluruh 29 rute (termasuk akun, support, checkout, pay) dikirim dalam satu
`index-*.js` ke pengunjung anonim yang mungkin cuma mau lihat satu produk.
`React.lazy` per rute akan memangkas ini banyak.

### T8. Aset: 7 file font + gambar tanpa `srcset`

- **7 woff2 (~98 KB)** dimuat di home: Outfit 400/600/700 + Manrope
  400/500/600/700. Pertimbangkan memangkas weight atau pakai variable font.
- **Tidak ada `srcset`**: gambar 800 px dipakai untuk slot thumbnail 44×44 px di
  hero (≈18× piksel lebih banyak dari yang perlu) dan kartu 353×176.
- `loading="lazy"` juga dipasang di gambar hero yang ada di atas lipatan —
  justru memperlambat LCP.

### T9. Saldo komisi referral tidak ada di web

`/account/referral` berbunyi *"dapat komisi tiap teman belanja (cek saldo di
bot)"*. Padahal halaman `/account` sudah menampilkan IDR & USDT Credit Balance —
jadi pengguna web dikirim ke Telegram hanya untuk satu angka. Jalan buntu untuk
pembeli yang tidak memakai bot.

### T10. Aturan password tidak ditampilkan di form register

Username punya hint jelas ("3–32 karakter: huruf kecil, angka, garis bawah"),
tapi password tidak punya apa-apa — padahal server mewajibkan minimal 8 karakter.
Aturannya hanya muncul lewat gelembung validasi native browser setelah submit.
Tidak konsisten, dan tidak ada indikator kekuatan password.

### T11. Registrasi tidak menyinggung Syarat & Ketentuan / Privasi

Halaman `/terms` dan `/privacy` ada dan isinya bagus, tapi form pendaftaran sama
sekali tidak menautkannya — tidak ada checkbox persetujuan maupun kalimat "dengan
mendaftar kamu setuju…". Untuk toko yang menjual dan menyimpan data pembeli, ini
sebaiknya ada.

### T23. Empat halaman auth (login, register, forgot, reset) sama sekali tidak punya header/footer

`App.tsx:81-84` menaruh `/login`, `/register`, `/forgot`, dan `/reset/:token` di
luar `<Route element={<Layout />}>` — satu-satunya klaster rute di seluruh app
yang begitu. Efeknya bukan sekadar kosmetik: keempat halaman ini render tanpa
header maupun footer sama sekali, cuma satu kartu ~28rem melayang di atas latar
polos.

Ini persis keluhan pemilik toko saat melihat situs langsung berjalan: *"login
page kosong banget"* — dan dia benar. Di layar 1440×900 kartunya cuma mengisi
sekitar seperempat viewport; sisanya kosong. Lihat
`storefront-eval-shots/01-login.png` dan `05-register.png`.

Efek samping yang lebih penting dari sekadar tampilan: karena tidak ada footer,
keempat halaman ini **tidak punya jalan ke kebijakan** (`/terms`, `/privacy`,
`/refund`) dan tidak ada jalan kembali ke toko selain logo kecil di dalam
kartu. Untuk pengunjung yang mendarat langsung di `/login` (lewat link luar,
atau redirect `?next=`), ini jalan buntu navigasi tepat di halaman paling awal
yang mereka lihat.

**Saran:** isi ruang kosong itu dengan materi yang toko sudah punya — nama/logo
toko, trust strip yang sama dengan yang dipakai di beranda ("Pengiriman instan
· QRIS & USDT · Bergaransi · Support 24/7"), dan link kebijakan yang sudah ada
di footer — alih-alih memindahkan keempat rute ini ke dalam `<Layout/>` penuh
(yang akan menumpuk header+footer toko di atas form yang sengaja dibuat
minimal).

---

## 4. Temuan kecil

| # | Temuan | Lokasi |
|---|---|---|
| T12 | `<nav>` footer diberi `aria-label` "Tentang kami" padahal isinya 7 link (produk, kategori, about, cara pesan, terms, privasi, refund). Screen reader membacanya "navigasi Tentang kami". `<nav>` di header malah tanpa label sama sekali. | `Layout.tsx:504-506`, `Layout.tsx:272` |
| T13 | Tombol menu punya `aria-controls="mobile-nav-drawer"`, tapi elemen itu baru ada saat drawer terbuka — referensi menggantung saat tertutup. | `Layout.tsx:245` |
| T14 | Tidak ada link "lompat ke konten". Pengguna keyboard harus tab melewati header di setiap halaman. | `Layout.tsx` |
| T15 | Saat pindah rute, fokus tetap tertinggal di link yang diklik dan tidak ada live region — perpindahan halaman tidak diumumkan ke screen reader. | `App.tsx` |
| T16 | `/account/reviews` menampilkan judul dobel: h1 "Ulasanku" langsung disusul heading "Ulasanku" lagi. | `ReviewsPage.tsx` |
| T17 | Tanggal tiket tampil `2026-08-09 00:48` — format ISO, bukan format lokal Indonesia. | `SupportPage.tsx` |
| T18 | Halaman produk menampilkan badge saat stok menipis atau habis, tapi tidak ada penanda positif saat stok banyak — kartu di listing menulis "Tersedia", halaman detail tidak. | `ProductPage.tsx` |
| T19 | Gambar produk demo di-hotlink dari `images.unsplash.com` (data seed). Untuk produksi pastikan lewat pipeline lokal/WebP yang sudah ada. | data seed |
| T20 | Casing label tidak konsisten: "Full Name" (Title Case) vs "Repeat password" (sentence case); di ID "Hubungi Kami" vs "Lihat produk". | `RegisterPage.tsx`, locales |
| T21 | Toggle bahasa menampilkan bahasa **tujuan**, bukan yang aktif (globe + "EN" saat situs berbahasa Indonesia). Ambigu — gampang dibaca sebagai "bahasa saat ini: EN". | `Layout.tsx:274-279` |
| T22 | Anchor hero memakai id Indonesia (`#produk`, `#kontak`, `#kategori`) walau seluruh UI-nya bisa berbahasa Inggris. Kosmetik/internal saja. | `HomePage.tsx` |

---

## 5. Animasi & motion

### Yang sudah bagus

Ada **sistem motion yang rapi**, bukan animasi tempel-tempelan.
`client/src/lib/motion.ts` mendefinisikan satu easing rumah
(`[0.22, 1, 0.36, 1]`), tiga token durasi (`fast` .15 / `base` .22 / `slow` .35),
dan varian yang dipakai ulang: `fadeUp`, `fadeIn`, `staggerContainer`,
`staggerItem`, `pressable` (tap → scale .97), `hoverLift`, `scrim`,
`slideInLeft`.

**Reduced motion dihormati dengan benar** — `main.tsx:35` membungkus aplikasi
dengan `<MotionConfig reducedMotion="user">`, jadi semua animasi framer-motion
otomatis mati kalau OS pengguna minta begitu.

**Scroll-reveal-nya digarap defensif.** `.reveal` mulai dari `opacity: 0` dan
dibuka oleh IntersectionObserver — pola yang biasanya berbahaya. Di sini ada
tiga lapis pengaman: fallback kalau `IntersectionObserver` tidak ada, fallback
`prefers-reduced-motion`, plus timeout `REVEAL_FALLBACK_MS` yang memaksa semua
`.reveal` tampil apa pun yang terjadi. Komentarnya menyebut tujuannya eksplisit:
*"no code path can leave content invisible forever"*. Ini benar.

**Skeleton loading berfungsi.** Diuji dengan throttle 200 kbps: 41 elemen
skeleton tampil dulu, lalu ditukar 3 kartu produk asli — tidak ada lompatan
layout saat pertukaran (CLS `/products` cuma 0.0014).

**Hapus item keranjang pakai konfirmasi inline** ("Hapus item ini dari
keranjang? Hapus / Batal"), bukan modal dan bukan sekali-klik-langsung-hilang.

Transisi berjalan ~60 fps (73 frame dalam 1200 ms).

### A1. Transisi antar-halaman menyisakan satu frame kosong

`PageTransition` memakai `AnimatePresence mode="wait"`, artinya animasi keluar
harus **selesai** sebelum animasi masuk dimulai. Diukur per frame di dalam
halaman (klik → `/terms`):

| Waktu | Opacity konten |
|---|---|
| 19 ms | 1.00 (halaman lama) |
| 79 ms | 0.07 (memudar keluar) |
| **146 ms** | **0.00 — layar benar-benar kosong** |
| 213 ms | 0.44 |
| 279 ms | 0.93 |
| 346 ms | 1.00 (selesai) |

Jadi **~330 ms per perpindahan halaman, dengan momen blank di tengahnya**.
Sendirian ini masih wajar. Masalahnya kalau digabung dengan **T3 (scroll tidak
di-reset)**: pengguna klik link di footer → layar berkedip kosong ~150 ms →
konten baru muncul, dan ternyata posisinya sudah ter-scroll di tengah halaman.
Dua hal ini saling memperburuk, dan T3 yang lebih murah diperbaiki.

Kalau mau transisinya tetap ada, `mode="popLayout"` atau crossfade tanpa `wait`
menghilangkan frame kosongnya.

### A2. Animasi FAQ tidak punya pengaman reduced-motion

`HomePage.css:7-19` — `details[open] > .faq-body { animation: faq-in .18s ease }`
tidak dibungkus `@media (prefers-reduced-motion: reduce)`, padahal `.reveal`
tepat di bawahnya punya. Durasinya cuma 180 ms jadi dampaknya kecil, tapi ini
inkonsistensi di file yang sama.

### A3. Status loading tidak diumumkan ke screen reader

Skeleton hanya perubahan visual — tidak ada `aria-busy` maupun live region saat
data sedang diambil (dicek: `[role=status]` = 0 selama loading). Pengguna screen
reader mendengar halaman kosong lalu tiba-tiba ada isi, tanpa tahu ada proses
memuat.

---

## 6. Tampilan (UI) & visual

### U1. Kilatan teks SEO mentah sebelum aplikasi muncul — sekaligus penyebab CLS

**Ini temuan visual paling serius.** Server mengirim
`<div id="seo-shell">` berisi h1/p/h2/ol asli (`spaShell.ts:210`,
`spaFallback.ts:59`), lalu React menghapusnya setelah mount
(`main.tsx:59`). Tidak ada satu pun CSS yang menyembunyikan div itu.

Akibatnya pada **muat dingin** (cache kosong, koneksi lambat), pengguna melihat
dinding teks tanpa gaya sama sekali sebelum aplikasi tampil — heading seukuran
teks biasa, rata kiri, tanpa layout. Bukti tangkapan layar:
`storefront-eval-shots/09-pre-hydration-flash.png`.

Efek terukurnya: tinggi body melompat dari **1000 px → 5192 px**, dan
**CLS halaman depan = 0.177** — di atas ambang "good" Google (0.1), masuk
kategori *needs improvement*.

| Halaman | CLS |
|---|---|
| `/` | **0.177** ⚠️ |
| `/p/capcut-pro-1-month` | 0.061 |
| `/products` | 0.0014 |

**Perbaikannya murah dan tidak mengorbankan SEO:** beri `#seo-shell` gaya
*visually hidden* (`position:absolute; width:1px; height:1px; overflow:hidden;
clip-path:inset(50%)`) alih-alih membiarkannya ikut alur layout. Crawler tetap
membacanya, pengguna tidak pernah melihatnya, dan CLS-nya hilang.

### U2. Token warna `--color-ink-faint` gagal kontras WCAG AA

`index.css:45` → `--color-ink-faint: #97a1b1`. Di atas kartu putih rasionya
**2.61:1**, sedangkan WCAG AA butuh **4.5:1** untuk teks normal.

Ini bukan kasus tunggal — token itu dipakai untuk teks yang justru perlu dibaca:

- nama kategori di setiap kartu produk ("Premium Apps", "Smoke Category")
- **seluruh harga ekuivalen USDT** ("≈ $0.80", "≈ $2.50") di kartu, halaman
  produk, keranjang, dan checkout
- kalimat penjelas di halaman produk ("Harga USDT hanya informasi — …")
- teks empty state di `/account/reviews`
- placeholder semua field (`app.css:126`)

Menggelapkannya ke sekitar `#6b7688` sudah cukup lolos AA sambil tetap terbaca
sebagai teks sekunder.

### U3. Kontras di bawah AA pada beberapa elemen lain

| Elemen | Rasio | Perlu |
|---|---|---|
| Link breadcrumb ("Beranda", "Premium Apps") | 2.45:1 | 4.5:1 |
| Header seksi akun ("PESANAN & PEMBELIAN", dll.) | 3.50:1 | 4.5:1 |
| Badge stok "Tersedia" | 4.49:1 | 4.5:1 (nyaris) |

> Catatan metode: teks putih di atas hero bergradien sempat terukur gagal, tapi
> itu **artefak pengukuran** — pencari latar hanya membaca `background-color`
> dan gradien tidak terbaca. Kasus itu sudah saya keluarkan dari tabel, jadi
> angka di atas hanya yang latarnya benar-benar solid.

---

## 7. Empty state

### Yang sudah bagus

Ada **satu komponen bersama** `components/shop/EmptyState.tsx` dengan API
`icon / title / description / action / secondaryAction`, dipakai di **13 tempat**.
Komentar dokumentasinya menyebut sejarahnya sendiri: dulu ada delapan versi
berbeda, salah satunya bahkan terkubur di dalam `<td colSpan={5}>`, dan
beberapa memberi tahu daftar kosong **tanpa** menawarkan jalan keluar. Prinsip
yang ditetapkan:

> *"An empty state is a dead end unless it names a next step, so `action` is
> what a caller should almost always pass."*

Prinsip itu dipatuhi: **11 dari 13** pemanggilan mengirim `action`, lima di
antaranya plus `secondaryAction`. Dua yang tidak (ulasan produk di
`ProductPage.tsx:481`, tiket di `SupportPage.tsx:168`) posisinya tepat di
sebelah aksi utamanya — tombol beli dan komposer tiket — jadi itu pengecualian
yang masuk akal, bukan kelalaian.

Nada copy-nya juga konsisten (sapaan "kamu", pola em-dash): *"Keranjang masih
kosong — lihat-lihat produk dulu."*, *"Tidak ketemu — coba kata kunci lain."*,
*"Belum ada pesanan — pembelianmu akan muncul di sini."*

### E1. `/account/reviews` tidak memakai komponen bersama

`ReviewsPage.tsx:155-161` membuat empty state-nya sendiri. Perbandingannya
dengan 13 yang lain:

| | `EmptyState` (13 tempat) | `ReviewsPage` |
|---|---|---|
| Ikon | ada (lucide 48 px) | **tidak ada** |
| Judul | `font-display` tebal, `text-ink` | teks biasa `text-ink-faint` |
| Deskripsi | ada | **tidak ada** |
| Tombol | `btn-primary` (solid) | `btn-soft` |
| Padding | `py-12 sm:py-16` | `py-10` |

Hasilnya terlihat jelas lebih pucat dan lebih kecil dari empty state lain —
bandingkan `storefront-eval-shots/11-empty-reviews.png` dengan
`storefront-eval-shots/10-empty-cart.png`. Teks satu-satunya di situ juga kena
**U2** (kontras 2.61:1), jadi pesan utamanya justru yang paling sulit dibaca.

Ironisnya komentar di baris 157 sudah menyebut *"same rationale as OrdersPage's
empty state"* — penulisnya tahu polanya, tapi komponennya tidak dipakai. Ini
persis pengulangan masalah yang `EmptyState.tsx` dibuat untuk menghentikan.

### E2. Empty state "belum ada pesanan" punya dua versi berbeda

- `OrdersPage.tsx:91` — ikon + judul + **deskripsi** + aksi + aksi sekunder
- `AccountPage.tsx:576` — ikon + judul + aksi, **tanpa deskripsi**

Kondisi yang sama persis (pembeli baru, belum ada pesanan) tampil dengan bobot
berbeda di dua halaman.

### E3. Keranjang kosong masih menampilkan stepper checkout

Di `/cart` yang kosong, indikator "1 · Keranjang → 2 · Pembayaran → 3 · Selesai"
tetap terpasang di atas. Menampilkan progres checkout tiga langkah padahal tidak
ada yang bisa di-checkout memberi kesan ada proses yang sedang berjalan. Lihat
`storefront-eval-shots/10-empty-cart.png`.

### E4. Tidak ada satu pun empty state yang menawarkan konten pemulihan

Semua 14 empty state menawarkan **tautan** keluar ("Lihat produk", "Kembali ke
beranda") — tidak ada yang menawarkan **produk**. Di layar 1440×900, keranjang
kosong menyisakan sekitar 500 px ruang kosong di bawah kartu.

Titik-titik ini justru momen dengan niat beli tertinggi (keranjang kosong,
pencarian gagal, belum ada pesanan). Menaruh 3–4 kartu "Produk terlaris" atau
"Terakhir dilihat" di bawah pesan akan mengubah jalan buntu jadi kesempatan,
dan komponennya (`ProductCard`) sudah ada.

---

## 8. Ulasan (saat ada isinya)

DB dev tidak punya ulasan sama sekali, jadi awalnya yang teruji hanya empty
state-nya. Untuk menguji tampilan aslinya saya menyuntikkan data ulasan
realistis lewat intersepsi respons API (tanpa menulis apa pun ke DB): ulasan
pendek, ulasan multi-paragraf, ulasan tanpa komentar (rating saja), ulasan
ber-emoji, ulasan berisi URL panjang, dan ulasan satu paragraf sangat panjang.

Hasilnya memang berantakan, dan penyebabnya tiga hal berbeda.

### R1. Satu ulasan berisi URL panjang merusak layout seluruh halaman 🔴

Paragraf komentar ulasan tidak punya `break-words` / `overflow-wrap`
(terukur: `overflow-wrap: normal`, `word-break: normal`). Satu kata panjang
tanpa spasi — **URL adalah kasus paling umum** — langsung menembus kartu:

| | Lebar konten | Lebar kartu | Akibat |
|---|---|---|---|
| Desktop 1440px | 752 px | 495 px | halaman jadi bisa di-scroll ke samping (1632 > 1589) |
| Mobile 390px | 879 px | 422 px | **scrollbar horizontal**, teks lari keluar layar |

Bukti: `storefront-eval-shots/13-reviews-overflow.png` (desktop) dan
`storefront-eval-shots/14-reviews-mobile-overflow.png` (mobile — scrollbar
horizontalnya kelihatan di bawah).

Ini bukan kasus teoretis: pembeli yang komplain hampir selalu menempelkan tautan
bukti ("buktinya di https://…"). Satu ulasan seperti itu cukup untuk membuat
halaman produk bergeser ke samping bagi **semua** pengunjung.

**Perbaikan:** tambahkan `break-words` (Tailwind) pada paragraf komentar.

### R2. Ulasan multi-paragraf gepeng jadi satu blok

Terukur: teks di DOM **masih mengandung karakter newline**, tapi CSS-nya
`white-space: normal` — jadi semua baris baru diratakan jadi satu paragraf
panjang. Ulasan yang ditulis rapi seperti ini:

```
Barang sesuai deskripsi.

Pengiriman cepat, admin ramah.
Cuma agak lama pas verifikasi pembayaran, sekitar 10 menit.

Overall puas, bakal beli lagi.
```

tampil jadi satu kalimat beruntun tanpa jeda sama sekali.

Yang bikin ini terasa janggal: di halaman yang **sama**, deskripsi produk
(`ProductPage.tsx:300` dan `:451`) sudah memakai `whitespace-pre-line`. Jadi
teks tulisan admin diperlakukan rapi, sementara teks tulisan pembeli tidak —
padahal justru tulisan pembeli yang paling tidak terduga bentuknya. Komponen
tiket (`TicketMessageThread.tsx:87`) juga sudah benar memakai
`whitespace-pre-line`. Ulasan adalah satu-satunya yang tertinggal.

### R3. Ulasan tanpa komentar jadi kartu nyaris kosong

Ulasan bintang-saja (tanpa teks) valid dan pasti terjadi. Yang muncul: kartu
berisi lima bintang, "C*** · 2026-07-25", lalu ruang kosong.

Diperparah oleh grid `sm:grid-cols-2`: tiap baris ditarik setinggi kartu
tertingginya, jadi kartu pendek dipaksa ikut tinggi. Terukur pada data uji —
113/113 px, 93/93 px, lalu **173/173 px**, di mana kartu kiri isinya cuma dua
baris teks tapi tetap setinggi 173 px. Hasilnya rongga-rongga kosong besar yang
persis terlihat "berantakan". Lihat `storefront-eval-shots/12-reviews-desktop.png`.

Pilihan perbaikan: `items-start` pada grid supaya kartu tidak ikut meregang,
atau layout masonry/kolom, atau sekalian satu kolom saja.

### R4. Halaman produk justru lebih miskin informasi daripada kartunya

`ProductCard.tsx:136-139` menampilkan **rating agregat**: bintang + angka
(mis. "4.6") + jumlah ulasan. Halaman detail produk **tidak menampilkannya sama
sekali** — `Stars` di situ hanya dipakai per-ulasan (`ProductPage.tsx:469`).

Jadi pembeli melihat "4.6 · 12 ulasan" di katalog, lalu masuk ke halaman produk
dan sinyal itu hilang, diganti daftar kartu tanpa ringkasan.

Ditambah lagi ulasan dibatasi **10 teratas** (`pageData.ts:154`,
`limit: 10`) tanpa jumlah total dan tanpa tautan "lihat semua". Produk dengan
200 ulasan terlihat sama saja dengan produk yang punya 10.

### R5. Masalah yang sama, lebih ringan, di balasan tiket

Diuji dengan mengirim balasan asli berisi URL panjang ke tiket uji #5: teksnya
juga menembus gelembung pesan (879 px di dalam wadah 463 px, `overflow-wrap:
normal`). Bedanya ada induk ber-`overflow-hidden`, jadi halaman tidak ikut
bergeser — teksnya "hanya" terpotong dan tidak terbaca. Tetap perlu
`break-words`, tapi tidak sedarurat R1.

### R6. Nama & tanggal pengulas nyaris tak terbaca

`{r.author} · {r.created_at_display}` memakai `text-ink-faint` → kontras
**2.61:1**, gagal WCAG AA (lihat **U2**). Ikut beres kalau token U2 diperbaiki.

> Catatan positif: nama pengulas sudah dimasker dengan benar jadi inisial +
> `***` (`pageData.ts:237`), dan ulasan ber-`hidden: true` memang tidak ikut
> terambil. Jadi soal privasi dan moderasi sudah aman — yang bermasalah murni
> penyajiannya.

---

## 9. Saran urutan pengerjaan

Diurutkan berdasarkan (dampak ÷ usaha), bukan sekadar tingkat keparahan.

**Perbaikan sebaris — kerjakan dulu, semuanya kecil:**

1. **R1 + R2** (`break-words` + `whitespace-pre-line` pada komentar ulasan) —
   dua kelas Tailwind di dua tempat (`ProductPage.tsx` ~474,
   `ReviewsPage.tsx:90`). Menghentikan satu ulasan berisi URL merusak layout
   halaman produk untuk semua pengunjung, sekaligus mengembalikan paragraf
   ulasan. Sekalian **R5** di `TicketMessageThread.tsx:87`.
2. **U1** (`#seo-shell` FOUC) — tambah satu aturan CSS *visually hidden*.
   Menghapus kilatan teks mentah **dan** memperbaiki CLS 0.177 sekaligus.
3. **U2** (`--color-ink-faint`) — ubah satu nilai token. Memperbaiki kontras di
   kartu produk, harga USDT, placeholder, empty state, dan **R6** sekaligus.
4. **T3** (scroll tidak reset) — satu `<ScrollRestoration />`.
5. **T1** (status hardcoded Inggris) — pindahkan satu map label ke `t()`.
   Paling sering dilihat pembeli.
6. **R3** (`items-start` pada grid ulasan) — satu kelas, menghilangkan rongga
   kosong antar-kartu.

**Berikutnya:**

7. **T2** (judul dokumen) — satu hook.
8. **E1** (`ReviewsPage` pakai `EmptyState`) — hapus markup buatan sendiri,
   sekalian menyelesaikan judul dobel **T16**.
9. **R4** (rating agregat + jumlah ulasan di halaman produk) — datanya sudah
   tersedia dan komponennya sudah ada di `ProductCard`, tinggal dipasang.
10. **A1** — setelah T3 selesai, nilai lagi apakah frame kosong transisi masih
    mengganggu; mungkin sudah cukup.
11. **T4** + **T5** — dua celah alur yang membuat pengguna kebingungan.
12. **T7/T8** — pekerjaan performa; kerjakan sekaligus.
13. **E4** (produk rekomendasi di empty state) — paling besar usahanya, tapi
    satu-satunya yang berpotensi menaikkan konversi.

Nomor 1–6 semuanya perubahan satu sampai beberapa baris, tidak saling
bergantung, dan bersama-sama menghilangkan hampir semua kesan "berantakan" yang
paling terasa sekarang: ulasan yang merusak layout dan kehilangan paragraf,
kilatan teks mentah saat dibuka, teks pucat yang sulit dibaca, mendarat di
tengah halaman, dan status berbahasa Inggris.

---

## 10. Koreksi — temuan yang ternyata salah (10 Agustus 2026)

Seluruh temuan di atas sudah dikerjakan dalam 16 task implementasi. Prosesnya
membongkar **lima temuan yang ternyata tidak berdiri**. Kelimanya berasal dari
satu kesalahan yang sama: **saya menguji keberadaan satu implementasi tertentu,
lalu menyimpulkan fiturnya tidak ada — padahal implementasi lain yang sah
sedang dipakai.** Dicatat di sini supaya dokumen ini tidak menyimpan klaim yang
tidak benar.

| # | Yang saya tulis | Kenyataannya | Probe yang keliru |
|---|---|---|---|
| **T7** | "Seluruh 29 rute dikirim dalam satu bundle 183 KB, termasuk akun, support, checkout, pay" | **21 dari 29 rute sudah `React.lazy`** sejak commit `0f904df8` (20 Juli 2026). Yang eager hanya 8 halaman katalog, dan itu disengaja | Saya hitung `<Route path=` lalu berasumsi satu bundle = semua rute, tanpa memeriksa gaya import-nya |
| **T8 (srcset)** | "Tidak ada `srcset`; gambar 800px dipakai di slot 44px" | `ProductCard.tsx` dan `ProductPage.tsx` **sudah** punya `<picture>` + `<source srcSet sizes>` tersambung ke pipeline WebP. Yang benar-benar kurang hanya thumbnail hero di `HomePage.tsx` | Saya baca properti `img.srcset` — kosong kalau srcset ada di elemen `<source>` saudaranya. Ukuran 800px yang saya lihat berasal dari data seed Unsplash yang tak punya turunan lokal, bukan dari markup yang salah |
| **A3** | "Tidak ada `aria-busy` dan tidak ada live region" | `aria-busy="true"` + `aria-label` **sudah ada** di semua skeleton sejak halaman-halaman itu diport. Yang tersisa valid hanya "tidak ada live region" | Saya hitung `[role=status]`, yang memang tidak akan pernah menangkap `aria-busy` |
| **U3 (header akun)** | "Header seksi akun 3.50:1, gagal AA" | **5.58:1 — lolos AA sejak awal.** Latarnya `bg-sand/60` di atas kartu putih, dan komposit alpha-nya lebih terang dari sand murni | Pencari latar saya membaca warna token mentah tanpa mengkomposit alpha — kelas kesalahan yang sama dengan artefak gradien hero yang sudah saya tandai sendiri di §6 |
| **T17** | "Tanggal tiket format ISO, tidak dilokalkan" | Daftar tiket **sudah** sama persis dengan seluruh tampilan tanggal lain di area akun | Saya bandingkan dengan ekspektasi saya sendiri, bukan dengan konvensi yang dipakai aplikasi ini |

Tiga di antaranya (T7, T8-srcset, A3) tetap berbuah perbaikan nyata, karena
pengerjaannya menemukan cacat lain di dekatnya. Yang paling penting: batas
`Suspense` ternyata dipasang **di atas** `Layout`, sehingga hard-load atau deep
link ke salah satu dari 21 rute lazy itu akan mengosongkan seluruh chrome
halaman — header, nav, footer. Itu bug sungguhan, hanya saja bukan bug yang
saya laporkan.

**Pelajarannya:** verifikasi di browser hanya sekuat probe-nya. Ketiadaan satu
penanda bukan bukti ketiadaan fitur — perlu dicek dulu apakah ada implementasi
lain yang sah sebelum sesuatu disebut temuan.

---

## Lampiran

- Screenshot: `storefront-eval-shots/` — `01` login, `02` produk, `03` produk
  habis, `04` checkout, `05` register, `06` mobile home, `07` mobile drawer,
  `08` akun, `09` kilatan teks SEO sebelum hydration (U1), `10` keranjang
  kosong (E3), `11` empty state ulasan yang menyimpang (E1), **`12` ulasan
  desktop — rongga kosong & paragraf gepeng (R2/R3)**, **`13` ulasan meluber
  desktop (R1)**, **`14` ulasan meluber mobile + scrollbar horizontal (R1)**.
- Ulasan pada §8 diuji lewat intersepsi respons API — **tidak ada baris ulasan
  yang ditulis ke DB**. Yang tertulis ke DB dev hanya satu balasan uji pada
  tiket #5 (untuk menguji R5).
- Playwright menulis artefak sementara ke `.playwright-mcp/` di root repo —
  sudah masuk `.gitignore` (baris 50), aman dibiarkan atau dihapus.
- Data uji yang tertinggal di DB dev: user `uji_playwright`
  (`uji.playwright@example.com`) dan tiket support `#5`.
- Screenshot verifikasi **setelah** perbaikan: `verify-login-desktop.png`
  (T23), `verify-cart-empty.png` (E3 + shelf), `verify-reviews.png` (R1/R2/R3).

## Status pengerjaan

Semua temuan dikerjakan di branch `worktree-storefront-eval-fixes`
(worktree `.claude/worktrees/storefront-eval-fixes`), 16 commit, suite naik
dari 3757 → **3838 test lulus**, `pnpm typecheck` bersih.

Hasil terukur setelah perbaikan:

| Temuan | Sebelum | Sesudah |
|---|---|---|
| U1 — CLS halaman depan | 0.177 | **0.0054** |
| U2 — kontras `ink-faint` | 2.61:1 | **4.84:1** |
| R1 — ulasan ber-URL panjang | halaman bisa di-scroll ke samping | tidak ada overflow |
| R2 — paragraf ulasan | gepeng jadi satu blok | `white-space: pre-line` |
| R3 — tinggi kartu ulasan | dipaksa 173/173 | 193/65/133/93, ikut isi |
| T2 — judul dokumen | tidak pernah berubah | benar per rute |
| T3 — scroll saat pindah rute | mendarat di y=405 | reset ke atas |
| T1 — chip status | 22 label Inggris mati | ikut bahasa |
