# 04 — Interaksi homepage

Metode: skrip Playwright pada 1440x900. Tidak ada transaksi.

| Elemen | Trigger | Pra-state | Pasca-state | URL/network | Keyakinan |
|---|---|---|---|---|---|
| Tombol "Tampilkan lebih banyak" (rak) | klik | 45 kartu produk | 86 kartu | URL tetap, tanpa XHR terdeteksi | OBSERVED |
| Tab kategori (mis. Voucher) | klik | scrollY awal | scrollY 4813 (ke rak) | URL tetap | OBSERVED |
| Carousel banner | menunggu 6 dtk | 5 gambar di DOM | tidak terbukti berubah | — | UNKNOWN (autoplay/swipe/durasi) |
| Pencarian "Cari game..." | ketik "mobile" + Enter | fokus di input | tidak ada dropdown terdeteksi, URL tetap | — | UNKNOWN (kemungkinan overlay, tidak terverifikasi) |
| Menu "Semua Produk" | — | — | belum diuji | — | UNKNOWN |

Implikasi: tab kategori adalah scroll-to-section, bukan filter; rak tumbuh di tempat tanpa halaman baru. Carousel dan search harus dirancang dari kebutuhan Trustance (kontrol pause, state loading/empty), bukan klaim "perilaku referensi".
