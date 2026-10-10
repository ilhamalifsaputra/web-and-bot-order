# Tindakan owner sebelum publikasi/pengajuan

## Konfirmasi yang sudah diterima

- Identitas PT Trustance Digital Indonesia serta data bisnis dinyatakan sesuai
  oleh owner; nilai berasal dari pengaturan admin. Agent tidak memeriksa akta/NIB.
- Xendit **belum aktif**, baru akan direview. Integrasi saat ini konfigurasi/probe
  admin, bukan metode checkout yang dapat digunakan. Tidak ada aktivasi otomatis.

## Checklist rilis dan NEEDS_OWNER_CONFIRMATION

1. Kesesuaian nama badan usaha, alamat dan NIB/KBLI sudah dikonfirmasi owner.
   Saat pengajuan, gunakan nilai/dokumen yang sama pada field Xendit. Simpan bukti
   di kanal privat perusahaan, tidak di repository; konfirmasi tidak diminta ulang.
2. Pastikan `help@trustance.id`, nomor telepon, jam 08:00–17:00 beserta zona waktu,
   WhatsApp/Telegram yang dikonfigurasi dipantau. Audit HTTP tidak membuktikan
   seseorang menerima pesan/telepon. Lengkapi TIMEZONE pada jam bila perlu.
3. Catat status live per gateway di dashboard provider. Snapshot checkout publik
   menampilkan TokoPay, Binance internal, Bybit internal/BSC; tidak mengesahkan
   settlement ataupun legalitas. Xendit/kartu tetap belum tersedia.
4. Siapkan sumber stok/hak penjualan untuk game bermerek (contoh katalog publik:
   Free Fire, Mobile Legends, Delta Force, Valorant, Growtopia, Arena Breakout),
   serta akun/subscription premium bila ada yang dijual. Cocokkan syarat supplier
   dan pemilik merek; jangan mengaku official/authorized reseller tanpa bukti.
5. Tinjau wallet IDR/USDT, top-up saldo, refund ke saldo dan crypto bersama
   penasihat/Xendit. Repository membuktikan fitur, bukan klasifikasi regulasi.
   Jangan menghapus atau menyembunyikannya untuk review.
6. **LEGAL_REVIEW_REQUIRED**: baca [diff teks kebijakan](legal-review.md).
   Tentukan tenggat pengajuan refund, SLA keputusan dan pencairan, metode/biaya
   pengembalian, serta cakupan garansi setiap paket. Draft tidak menjanjikan
   deadline yang belum dibuktikan. Dapatkan review hukum bila perlu sebelum rilis.
7. Konfirmasi privacy claims: siapa mendapat data, akses staf, Telegram/email,
   analytics, penggunaan broadcast/promosi dan persetujuan pelanggan, periode
   retensi, proses permintaan akses/koreksi/penghapusan dan
   pengecualian penyimpanan transaksi. Bcrypt hashing telah diverifikasi di kode;
   tidak berarti semua data terenkripsi end-to-end. Klaim tidak menjual data atau
   tidak mengirim promosi tanpa diminta membutuhkan konfirmasi operasional owner,
   bukan kesimpulan dari source code saja.
8. Review Settings `shop_tagline`, custom `welcome`, banner bot dan deskripsi SKU
   yang tersimpan: perubahan locale tidak menimpa data custom. Hindari copy
   premium-only untuk posisi global, tetap pertahankan deskripsi produk aktual.
9. Logo upload saat ini sudah ditemukan; bila ingin lebih terbaca pada mobile,
   upload versi transparan/minim whitespace melalui Branding. Tidak perlu logo
   baru untuk memakai patch; tidak ada asset produksi yang ditimpa oleh audit.
10. Setelah teks disetujui, review branch dan rilis bundle server+storefront+admin
    bersama melalui proses deployment normal. Ulangi smoke public sesudah rilis
    serta pengukuran CWV pada jaringan/perangkat nyata; sampel localhost bukan
    hasil performa lapangan.
    Task ini tidak push, deploy, mengirim email/Telegram, atau membayar live.

Keputusan merchant tetap milik Xendit. Audit kode tidak menjamin penerimaan.
