# Screenshot audit lokal

Seluruh identitas, alamat dan akun dalam screenshot adalah sintetis. Tidak ada
cookie, data pelanggan, kredensial produk nyata atau pembayaran live.
Chromium; capture akhir sesudah patch memakai reduced motion melalui browser
context. Capture baseline sebelum patch memakai preferensi default browser.
Desktop dan mobile menggunakan build produksi. Baseline dapat merekam animasi
awal atau gambar deferred yang belum selesai; gunakan untuk membandingkan
struktur/copy, bukan sebagai benchmark kontras/performa atau pixel diff.

| Viewport | Contact sebelum | Contact sesudah | Home sebelum | Home sesudah |
|---|---|---|---|---|
| 360×800 | [before](before-contact-360.png) | [after](after-contact-360.png) | [before](before-home-360.png) | [after](after-home-360.png) |
| 390×844 | [before](before-contact-390.png) | [after](after-contact-390.png) | [before](before-home-390.png) | [after](after-home-390.png) |
| 430×932 | [before](before-contact-430.png) | [after](after-contact-430.png) | [before](before-home-430.png) | [after](after-home-430.png) |
| 1280×800 | [before](before-contact-1280.png) | [after](after-contact-1280.png) | [before](before-home-1280.png) | [after](after-home-1280.png) |
| 1440×900 | [before](before-contact-1440.png) | [after](after-contact-1440.png) | [before](before-home-1440.png) | [after](after-home-1440.png) |

Perubahan: ikon Store sebagai identitas fallback menjadi wordmark, kontak mobile
tertutup secara default, padding lebih singkat, tautan kebijakan selalu tersedia,
dan mark kartu tidak tampil hanya karena key konfigurasi Xendit tersedia. Alamat
operator tetap di luar accordion. Desktop mempertahankan kolom.

`after-owner-logo-*.png` adalah pemeriksaan tambahan asset publik Trustance yang
telah ada, dalam box tetap 44px. Audit tidak mengedit/menggambar ulang logo.
`route-results.json` mencatat status, viewport, overflow dan error request yang
diamati; 404 sintetis dan 401 menuju login dilaporkan sebagai state yang disengaja.

Screenshot tidak membuktikan SLA provider, monitoring kontak, hak distribusi,
sertifikasi aksesibilitas atau persetujuan merchant.

Contact full-page pada fixture yang sama memendek: 360px dari tinggi 1606 ke
1435px; 390px 1550 ke 1395px; 430px 1521 ke 1366px. Desktop 1423 ke 1392px.
Identitas/alamat tidak dihapus. Ukuran ini hasil screenshot lokal, bukan target
resmi Xendit atau ukuran baku untuk konten produksi.
