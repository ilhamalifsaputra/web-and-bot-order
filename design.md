# design.md — Website Jualan (Storefront)

> Dokumen desain untuk **toko online (storefront)** yang dipakai **pelanggan**.
> Tujuannya: tampil **konsisten 1:1** dengan web-admin yang sudah ada
> (`BOT dan Web Admin/apps/web-admin`) — tema **"Clean Modern"** — tetapi
> di-_adaptasi_ untuk pengalaman belanja (hero, grid produk, gambar, keranjang,
> checkout). Storefront berbagi database & stok yang sama dengan bot Telegram,
> jadi yang berubah hanya **tampilan**, bukan datanya.
>
> Implementasi belum dikerjakan. Lihat [plan.md](plan.md) untuk arsitektur &
> tahapan. Dokumen ini hanya **spesifikasi desain**.

---

## 1. Prinsip desain

1. **Satu bahasa visual dengan admin.** Token warna, font, radius, shadow, dan
   komponen (`.card`, `.btn`, `.chip`, `.field`, `.data-table`) **identik** dengan
   `apps/web-admin/views/base.njk`. Kalau admin diganti temanya, storefront ikut
   berubah dari token yang sama.
2. **Bahasa polos, tanpa jargon.** Sama seperti aturan admin (memori
   `web-admin-plain-language`): tidak ada istilah teknis. "Stok habis", bukan
   "OUT_OF_STOCK". "Pesananku", bukan "ORDER #". Storefront ditujukan untuk
   pelanggan awam.
3. **Belanja itu visual.** Berbeda dari admin yang padat tabel, storefront
   mengutamakan **gambar produk, kartu, dan ruang putih**. Gambar memakai
   **Unsplash** (pihak ketiga) yang gampang diganti nanti (lihat §7).
4. **Mobile-first.** Mayoritas pembeli buka dari HP (kebanyakan datang dari link
   bot Telegram). Layout default 1 kolom, naik ke grid di layar lebar.
5. **Stok jujur & real-time.** Karena DB-nya sama dengan bot, jumlah stok yang
   tampil = stok asli. Tampilkan badge stok di setiap kartu produk; jangan biarkan
   orang checkout barang yang sudah habis.
6. **Cepat, ringan, tanpa build berat.** Ikuti admin: Tailwind via CDN + HTMX,
   bukan SPA. Halaman server-rendered (Nunjucks) supaya ringan & SEO-friendly.

---

## 2. Design tokens (disalin persis dari web-admin)

Sumber kebenaran: `apps/web-admin/views/base.njk` (Tailwind config inline). Nilai di
bawah **harus sama** supaya dua web kelihatan satu keluarga. Nama token tetap
(`pine` sekarang membawa warna biru — jangan diganti namanya).

### Warna

| Token | Hex | Pakai untuk |
|---|---|---|
| `paper` | `#f6f8fb` | Latar halaman (off-white sejuk) |
| `card` | `#ffffff` | Permukaan kartu |
| `sand` | `#eef1f6` | Latar hover / header tabel |
| `line` | `#e3e8ef` | Garis & border |
| `ink` | `#1b2330` | Teks utama |
| `ink.soft` | `#5a6473` | Teks sekunder |
| `ink.faint` | `#97a1b1` | Teks samar / placeholder |
| `pine` (brand) | `#2563eb` | Aksen utama, tombol, link, harga aktif |
| `pine.dark` | `#1d4ed8` | Hover tombol primer |
| `pine.tint` | `#e6effe` | Latar lembut / chip brand |
| `grass` | `#16a34a` | Sukses / "Tersedia" / "Lunas" |
| `grass.tint` | `#e7f6ec` | Latar badge sukses |
| `amberx` | `#b45c0a` | Peringatan / "Menunggu pembayaran" / stok menipis |
| `amberx.tint` | `#fdedcf` | Latar badge peringatan |
| `rust` | `#dc2626` | Bahaya / "Stok habis" / batal |
| `rust.tint` | `#fde7e7` | Latar badge bahaya |

**Arti warna status** (sama dengan macro `status_badge` admin):
hijau = baik/selesai/tersedia · biru = menunggu/info · amber = perlu perhatian ·
merah = berhenti/habis/batal.

### Tipografi

Google Fonts (preconnect sama seperti admin):

- **Outfit** (`font-display`) — judul (`h1/h2/h3`), nama produk, harga besar.
- **Manrope** (`font-sans`) — teks isi, deskripsi, label.
- **JetBrains Mono** (`font-mono`) — kode pesanan, kredensial, ID, angka txid.

Skala (ikut admin): `.page-title` = `text-3xl font-semibold tracking-tight`;
`.section-title` = `text-lg font-semibold`; body = `text-sm`.

### Bentuk & bayangan

- Radius: kartu `rounded-2xl` (1rem) / token `xl2` (1.25rem) untuk panel besar;
  tombol `rounded-xl`; chip `rounded-full`.
- Shadow: `shadow-soft` (kartu diam), `shadow-lift` (dropdown, kartu hover,
  cart drawer).

### Ikon

**Lucide** (`https://unpkg.com/lucide`), sama dengan admin. Ikon mewarisi
`currentColor`. Beberapa yang relevan untuk storefront:
`store, shopping-cart, shopping-bag, package, search, heart, star, wallet,
truck, shield-check, badge-check, bell, user, log-in, chevron-right, filter,
tag, ticket-percent, life-buoy, gift`.

---

## 3. Komponen yang dipakai ulang dari admin

Salin/port langsung dari `base.njk` `<style type="text/tailwindcss">` &
`_macros.njk` agar identik:

- `.card`, `.card-pad` — permukaan utama.
- `.btn`, `.btn-primary`, `.btn-soft`, `.btn-ghost`, `.btn-danger`, `.btn-sm`.
- `.field`, `.field-label` — input & form.
- `.chip` + macro `status_badge(value)` — badge status (pesanan, stok).
- `.link`, `.codeish` — link & teks kode (mono).
- `.stat-label/.stat-value/.stat-sub` — kartu angka (dipakai di halaman Akun).
- macro `flash(message, kind)`, `empty_row(cols, msg)`, `csrf_field(admin)`,
  `ic(name, cls)`.

> Cara teknis menjaga konsistensi: idealnya komponen ini diekstrak ke satu file
> partial bersama yang di-_include_ kedua app. Lihat [plan.md §6](plan.md) (opsi
> "shared theme partial"). Minimal: copy nilai token & blok `@layer components`
> apa adanya.

---

## 4. Komponen baru khusus storefront

Komponen di bawah **memakai token yang sama**, tapi belum ada di admin.

### 4.1 Header toko (storefront nav)
Berbeda dari nav admin (yang penuh menu manajemen). Header toko ringkas:

```
┌────────────────────────────────────────────────────────────────┐
│ 🛍 NamaToko        [ cari produk… 🔍 ]      Akun▾   🛒 Keranjang(2)│
└────────────────────────────────────────────────────────────────┘
```
- Kiri: logo + nama toko (ikon `store`, warna `pine`) — sama gaya brand admin.
- Tengah: search bar (`.field` + ikon `search`), submit ke `/search`.
- Kanan: tombol **Keranjang** (ikon `shopping-cart` + badge jumlah `chip
  bg-pine text-white`), menu **Akun** (jika login: nama + avatar; jika belum:
  tombol **Masuk** via Telegram).
- Sticky, `bg-card/85 backdrop-blur border-b border-line` (persis admin).
- Mobile: search jadi baris kedua / ikon yang membuka overlay; menu jadi
  bottom-bar opsional (Beranda · Cari · Keranjang · Akun).

### 4.2 Kartu produk (`.product-card`)
Inti storefront. Grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4`.

```
┌──────────────────┐
│  [ gambar 4:3 ]  │ ← Unsplash, object-cover, rounded-t-2xl
│                  │
├──────────────────┤
│ Netflix 1 Bulan  │ ← font-display, text-sm font-semibold, truncate 2 baris
│ Streaming        │ ← text-ink-faint text-xs (kategori)
│ ★ 4.8 · terjual…│ ← rating (grass/amber) + sosial proof (opsional)
│                  │
│ $5.00   [Tersedia]│ ← harga (pine, font-display) + badge stok
│      [ + Keranjang ]│ ← .btn-primary .btn-sm  (atau "Beli")
└──────────────────┘
```
- Hover: `shadow-lift` + sedikit translate-y (micro-interaction).
- Badge stok pakai `status_badge`: `available`→hijau "Tersedia",
  stok≤ambang→amber "Sisa N", 0→merah "Habis" (tombol jadi **Kabari saat
  ready** / restock).
- Harga reseller hanya tampil bila user login sebagai reseller (`User.role`).

### 4.3 Badge stok (`stock_badge(count, lowThreshold)`)
Macro baru di atas `status_badge`:
- `count > low` → chip hijau "Tersedia".
- `0 < count ≤ low` → chip amber "Sisa {count}".
- `count == 0` → chip merah "Stok habis".

### 4.4 Price tag (`.price`)
`font-display font-semibold text-pine`. Varian: harga coret (`line-through
text-ink-faint`) saat ada diskon kuantitas/voucher. **Selalu IDR + USDT
bersisian**: `Rp79.000` sebagai angka utama dengan `≈ $4,9` (USDT turunan kurs,
sudah dibulatkan — §8b) sebagai info di sampingnya, untuk **semua** pembeli.

### 4.5 Cart drawer / panel keranjang
Panel kanan `shadow-lift` (HTMX swap), atau halaman `/cart` penuh:
```
Keranjang (2)                                   ✕
─────────────────────────────────────────────
[img] Netflix 1 Bulan        $5.00   [- 1 +]  🗑
[img] Spotify 3 Bulan        $9.00   [- 1 +]  🗑
─────────────────────────────────────────────
Subtotal                               $14.00
Punya kode diskon? [______]  [Pakai]
─────────────────────────────────────────────
        [   Lanjut ke pembayaran →   ]
```
Item = `CartItem` (sudah ada di DB, keyed by `userId`). Update qty/hapus via
HTMX → kembalikan partial panel.

### 4.6 Langkah checkout (stepper)
Chip langkah memakai `pine`/`grass`:
`(1) Keranjang → (2) Pembayaran → (3) Selesai`. Step aktif `bg-pine text-white`,
selesai `bg-grass-tint text-grass-dark`, depan `bg-sand text-ink-soft`.

### 4.7 Rating bintang (`stars(rating)`)
5 ikon `star`; terisi `text-amber-400 fill-current`, kosong `text-line`.
Dipakai di kartu & detail produk (rata-rata dari tabel `Review`).

### 4.8 Hero / banner beranda
Banner lebar (`rounded-2xl overflow-hidden`) dengan gambar Unsplash + overlay
gelap lembut + judul `font-display text-3xl/4xl text-white` + sub + tombol CTA
`.btn-primary`. Catatan: bot sudah punya fitur **banner_image** (memori
`bot-banner-feature`) — storefront sebaiknya pakai sumber gambar yang sama bila
nanti diisi admin; default-nya Unsplash (lihat §7).

### 4.9 Category pills
Baris chip bisa di-scroll horizontal untuk filter kategori:
`chip` aktif `bg-pine text-white`, lainnya `bg-sand text-ink-soft hover:bg-pine-tint`.
Sumber: tabel `Category` (yang `isActive`), urut `sortOrder`, ikon dari `emoji`.

---

## 5. Peta halaman & layout

Semua halaman extend `base.njk` (versi storefront, header toko menggantikan nav
admin). Lebar konten `max-w-6xl mx-auto px-4`. Grid produk boleh `max-w-7xl`.

| Route | Halaman | Isi utama |
|---|---|---|
| `/` | **Beranda** | Hero · category pills · "Terlaris"/"Baru" (grid produk) · banner promo |
| `/c/:slug` atau `/?cat=` | **Daftar produk** | Filter kategori + urut (harga/terbaru) · grid produk · paginasi |
| `/p/:id` | **Detail produk** | Galeri gambar · nama/harga/badge stok · deskripsi · garansi · diskon kuantitas · rating + review · tombol Beli/Keranjang · "Kabari saat ready" |
| `/search?q=` | **Hasil cari** | Reuse grid produk |
| `/cart` | **Keranjang** | Daftar item · kode diskon · ringkasan · CTA checkout |
| `/checkout` | **Checkout** | Stepper · ringkasan (IDR + USDT bersisian) · **pilih metode bayar** yang menetapkan mata uang (USDT→Binance UID, IDR→TokoPay) · **tanpa saldo** (wallet ditunda, plan.md §17.1) |
| `/checkout/:code/pay` | **Pembayaran** | USDT: instruksi Binance Internal (UID + nominal unik) · IDR: QRIS/VA TokoPay · countdown · **status auto-confirm via HTMX polling** (tanpa upload bukti) |
| `/account` | **Akun** | Kartu ringkas (jml pesanan, kode referral) · menu |
| `/account/orders` | **Pesananku** | Daftar pesanan + status (`status_badge`) |
| `/account/orders/:code` | **Detail pesanan** | Item · status · **kredensial** (mono, tombol salin) bila DELIVERED · garansi · ajukan komplain/ganti |
| ~~`/account/wallet`~~ | **Saldo** | _ditunda web v1 — kelola via bot (plan.md §17.1 #5)_ |
| `/account/referral` | **Referral** | Kode + link bagikan (komisi dilihat di bot) |
| `/account/reviews` | **Ulasanku** | Beri/ubah ulasan untuk pesanan terkirim |
| `/account/support` | **Bantuan** | Daftar tiket + buat tiket baru (`SupportTicket`) |
| `/login` | **Masuk** | Tombol **Login with Telegram** (widget) |
| `/about`, `/terms` | Statis | Info toko, S&K (opsional) |

### Wireframe detail produk (acuan)
```
┌───────────────────────┐   Netflix Premium — 1 Bulan
│                       │   Streaming · ⏳ Garansi 30 hari
│    [ gambar besar ]   │   ★★★★★ 4.8 (32 ulasan)
│                       │
│  [thumb][thumb][thumb]│   Rp79.000 / $5.0     [ Tersedia ]
└───────────────────────┘   Beli 3+ → hemat 10%
                            ┌─────────────────────────────┐
Deskripsi…                  │  Jumlah [- 1 +]             │
Profil sharing, garansi…    │  [   + Keranjang   ][ Beli ]│
                            └─────────────────────────────┘
─────────────────────────────────────────────────────────
Ulasan pembeli
★★★★★  "Cepat, akun work." — A***  · 2 hari lalu
```

---

## 6. Imagery — strategi Unsplash (editable)

Produk di DB menyimpan `imageFileId` = **Telegram file_id**, yang **tidak bisa**
dipakai langsung sebagai `<img src>` di web. Karena itu:

1. **Default: Unsplash.** Gunakan gambar Unsplash sebagai placeholder yang rapi
   & relevan per kategori/produk. Pakai **Unsplash Source / URL** atau daftar URL
   yang dikurasi, dengan parameter ukuran (`?w=800&q=80&auto=format&fit=crop`)
   supaya ringan.
2. **Gampang diganti nanti** (sesuai permintaan): semua URL gambar dikumpulkan di
   **satu tempat** — usul: file `apps/storefront/src/images.ts` (atau kolom DB
   baru `web_image_url`, lihat plan.md §8 "open decisions"). Jadi mengganti
   gambar = ubah satu peta, tidak menyebar di template.
   ```ts
   // contoh peta — pseudocode, bukan implementasi final
   export const productImage = (p) =>
     IMAGE_OVERRIDES[p.id] ??               // 1) override manual admin
     categoryImage(p.category?.name) ??     // 2) gambar per kategori (Unsplash)
     PLACEHOLDER;                           // 3) fallback netral
   ```
3. **Hero & kategori**: pakai koleksi Unsplash bertema (mis. "streaming",
   "gaming", "software") — disimpan sebagai konstanta yang jelas diberi komentar
   `// TODO: ganti dengan foto produk asli`.
4. **Rasio & kualitas seragam**: kartu 4:3 (`aspect-[4/3] object-cover`), hero
   21:9 atau 16:9, detail 1:1/4:3. Selalu `object-cover` + `bg-sand` sebagai
   warna loading.
5. **Atribusi/lisensi**: catat bahwa ini placeholder Unsplash; saat produksi
   diganti foto milik toko (lihat plan.md untuk to-do legal/atribusi bila pakai
   Unsplash API resmi).
6. **Performa**: `loading="lazy"`, `decoding="async"`, srcset opsional. Hindari
   gambar > 1600px.

---

## 7. Responsif, aksesibilitas, & interaksi

- **Breakpoint**: 1 kolom < `sm`, grid 2 kolom `sm`, 3 `md`, 4 `lg` untuk produk.
  Header collapse ke ikon + bottom-bar di mobile.
- **Kontras**: `ink` di atas `paper`/`card` lolos AA. Jangan andalkan warna saja
  untuk status — selalu ada **label teks** (sudah ditangani `status_badge`).
- **Fokus**: ring `focus:ring-2 focus:ring-pine/30` (sudah di `.btn`/`.field`).
- **Keyboard & alt**: tiap gambar produk `alt="{nama produk}"`; tombol ikon punya
  `aria-label`.
- **Micro-interaction**: hover kartu naik + `shadow-lift`; tombol transisi 150ms;
  badge keranjang animasi kecil saat nambah; toast HTMX untuk "Ditambahkan ke
  keranjang".
- **Loading**: skeleton `bg-sand animate-pulse` untuk grid saat HTMX load.
- **Empty states**: ramah & berarah (macro `empty_row` gaya), mis. "Keranjang
  masih kosong — lihat produk →".

---

## 8. Bahasa (i18n)

Bot sudah dwibahasa **EN + ID** (`packages/core/locales/{en,id}.json`).
Storefront sebaiknya **memakai i18n yang sama** (`@app/core/i18n`):
- Default mengikuti `User.language` bila login, atau cookie/toggle bahasa.
- Tambah key storefront-baru ke **kedua** file locale (jaga key set identik —
  aturan CLAUDE.md).
- Copy default di dokumen ini ditulis Bahasa Indonesia sebagai contoh untuk
  pelanggan; padanan EN wajib disediakan.

> Catatan: web-admin memilih English polos karena adminnya. Storefront melayani
> pelanggan (kemungkinan Indonesia), jadi dwibahasa lebih tepat. Keputusan final
> ada di plan.md §8.

---

## 8b. Tampilan harga (IDR utama + USDT info) & pembayaran

Harga **terpusat dalam Rupiah** (satu harga, diisi admin — lihat
[plan.md §15](plan.md)); **USDT diturunkan otomatis dari kurs** (`usd_idr_rate`)
lalu **dibulatkan ke 0,1 terdekat** (mis. `$2.453 → $2,5`). **Tidak ada deteksi
IP** dan **bukan satu mata uang per-pembeli**: **semua** pembeli melihat **IDR
sebagai angka utama + USDT (bulat) sebagai info di sampingnya**. Mata uang
transaksi baru ditentukan **saat membayar** (pilih metode).

- **Format angka** (macro `price` merender keduanya sekaligus):
  - IDR → `Rp79.000` (tanpa desimal, pemisah ribuan **titik** — konvensi ID;
    `font-display`, warna `pine`).
  - USDT → `≈ $4,9` (sudah dibulatkan ke 0,1; ukuran lebih kecil, `text-ink-soft`)
    bersisian/di bawah angka IDR sebagai pelengkap, bukan menggantikan.
- **Tidak ada pemilih mata uang** di header (tak ada chip `[ Rp ▾ ]`, tak ada
  "ganti mata uang", tak ada deteksi IP). Header cukup pemilih **bahasa** saja.
- **Konversi sekali** per harga/total yang ditampilkan (jangan per-komponen) agar
  tak ada selisih pembulatan ganda; bulatkan **total order USDT** di akhir.
- **Harga reseller**: dari `resellerPrice` (IDR) → USDT diturunkan sama; hanya
  tampil bila user reseller.
- **Diskon**: harga coret + harga diskon tampil untuk kedua angka. Badge "hemat
  10%" (persen) berlaku relatif (sama untuk IDR & USDT).
- **Sisi admin**: admin **hanya mengisi harga Rupiah**; boleh ada **preview USDT
  (read-only)** dari kurs di form produk — sama dengan yang dilihat pembeli.
- **Pilih metode bayar = pilih mata uang** (di `/checkout` & `/checkout/:code/pay`):
  - **Rupiah / TokoPay** → order `IDR`; tampilkan **QRIS / Virtual Account /
    e-wallet** (logo channel), status menunggu, lalu sukses (konfirmasi callback).
  - **USDT / Binance** → order `USDT`; tampilkan **Binance Internal Transfer (UID +
    nominal unik) + countdown**, status auto-confirm (poller). **USDT hanya via
    Binance**; web tanpa upload bukti manual (plan.md §17.1).
  Keduanya pakai komponen kartu & stepper yang sama (design.md §4.6) — hanya isi
  instruksi yang beda. Status "menunggu → lunas" diperbarui via **HTMX polling**.
- **Satu harga pusat (Rupiah)** per produk; USDT selalu turunan kurs. Produk tanpa
  harga disembunyikan. Bila `usd_idr_rate` belum diisi, **info USDT** disembunyikan
  (IDR tetap tampil & bisa checkout via TokoPay); jalur **bayar USDT/Binance**
  nonaktif sampai kurs diisi.

---

## 9. Yang TIDAK dilakukan (selaras aturan proyek)

- **Web tidak pernah kirim Telegram langsung.** Notifikasi (kredensial,
  konfirmasi) selalu lewat `notification_outbox` → notifier/bot. (CLAUDE.md)
- **Tidak menampilkan data sensitif mentah**: `paymentProofFileId`, `file_id`,
  hash — sembunyikan/abstraksi. Kredensial hanya tampil ke pemilik pesanan yang
  sudah DELIVERED.
- **Tidak ada SQL mentah di route** — semua lewat `packages/db/src/crud/*`.
- **Jangan ubah nama kolom/skema** — DB dipakai bersama bot. (memori
  `enum-storage-uppercase`, `datetime-storage-incompat`)

---

## 10. Ringkasan "definition of done" visual

Storefront dianggap sesuai desain bila:
1. Buka berdampingan dengan web-admin → terasa **satu produk** (font, warna,
   kartu, tombol, badge sama).
2. Semua warna/font berasal dari **token yang sama**; ganti token → kedua web
   berubah.
3. Tiap produk punya **gambar (Unsplash, mudah diganti)** + **badge stok jujur**.
4. Bahasa polos, dwibahasa, tanpa jargon teknis.
5. Mobile-first, lolos kontras AA, ada empty/loading/error state.
```
