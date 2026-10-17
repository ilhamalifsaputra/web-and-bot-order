# 01 — Rekonaisans homepage (https://gogogo.com/id-id)

Bukti: `assets/ref-home-1440.png`, snapshot aksesibilitas, computed style. Semua OBSERVED kecuali dinyatakan lain.

## Urutan section (atas ke bawah, 1440 px)
1. **Header sticky** (`position: sticky; top: 0; z-index: 30`): logo, tautan Transaksi / Promo / Bantuan, menu "Semua Produk", pencarian "Cari game...", tombol koin, Login.
2. **Banner promo** — carousel dengan panah kiri/kanan dan indikator; gambar promo bergantian.
3. **Tagline** (h1, 35.2 px, bold) + paragraf + strip trust yang bergulir (Money Back Guarantee, Official and Trusted Supply, 24/7 Customer Support).
4. **Tab kategori pill**: Lagi Populer, Top Up, Steam Game, Voucher, Entertainment (35 px tinggi, radius penuh, padding 10/16, tab aktif teks kuning rgb(255,189,43), lainnya latar putih 10%).
5. **Lima rak** (h2, 24 px): tiap rak grid kartu poster (radius 8 px, gambar `object-fit: cover`, `loading=lazy`) dengan rating, nama, jumlah terjual. Rak Top Up/Steam/Voucher/Entertainment punya tombol "Tampilkan lebih banyak"; rak pertama (populer) tidak.
6. **Blok bantuan**: "Gak nemu game yang kamu cari?" (Kasih Saran) dan "Kamu butuh bantuan?" (Hubungi CS).
7. **FAQ** accordion 4 butir + "Tampilkan lebih banyak".
8. **Footer**: logo, wilayah/bahasa, metode bayar, kolom tautan Top Up / Voucher / Informasi Umum, Play Store, Instagram, syarat dan privasi.

## Layout
- Kontainer maks 1250 px (margin otomatis); body latar `rgb(30,30,30)`, font Red Hat Display 15 px/500.
- Kartu 5 kolom di rak (desktop). Tidak ada overflow horizontal (scrollWidth 1425 = lebar viewport).
- Mobile: tab bar bawah `position: fixed` (`lg:hidden`, z 100).

## Pemisahan produk (jawaban pertanyaan "ada pemisahan?")
Gogogo memisahkan **empat kelompok**: Top Up (game), Steam Game, Voucher, Entertainment. Trustance hanya punya dua (`GAME_TOPUP`, `PREMIUM_APPS`); keputusan user: sekarang tetap dua, kelompok baru menunggu penambahan service.

## Belum teramati
Interaksi carousel (autoplay, swipe, durasi), perilaku dropdown "Semua Produk", hasil pencarian, dan kelakuan "Tampilkan lebih banyak" — UNKNOWN sampai diuji.
