# Checklist kesiapan review Xendit

10 Oktober 2026. Status kode lokal tidak sama dengan status merchant live.
Owner menyatakan identitas bisnis sesuai dan dapat diatur dari admin. Owner juga
menegaskan **Xendit belum aktif, baru akan direview**. Bukti legal/due diligence
tidak diperiksa langsung oleh agent.

| Jenis / kriteria | URL / komponen | Status | Evidence | Action |
|---|---|---|---|---|
| Resmi: website aktif dan dapat diakses | Public `/`, `/about`, `/contact`, `/terms`, `/privacy`, `/refund` | PASS | GET anonim read-only semuanya HTTP 200 | Ulangi setelah rilis yang disetujui |
| Resmi: sesuai bisnis dan katalog/alur pembelian | Catalog + checkout | PASS | Backend/SPA mendukung produk digital; katalog publik saat audit Mobile Game dan PC Game; checkout anonim tersedia | Pengajuan harus sesuai seluruh produk yang benar-benar dijual, bukan hanya teks rebrand |
| Resmi: kesesuaian identitas/dokumen bisnis | Identitas bisnis / NIB / dokumen pengajuan | PASS | Berdasarkan konfirmasi owner bahwa sudah sesuai; agent tidak menerima atau memeriksa dokumen langsung | Gunakan identitas/dokumen yang sama pada pengajuan; tanggapi permintaan dokumen tambahan dari Xendit |
| Teknis: identitas satu sumber | Footer/Contact/About/Terms/Privacy | PASS | Settings business_*, konfirmasi owner, pengujian context dan substitusi company | Pertahankan nama/alamat/kontak yang sama pada pengajuan |
| Teknis: tidak mengklaim Xendit live | Terms/Privacy/mark kartu | PASS | Xendit belum aktif menurut owner; tidak ada rail Xendit di checkout; patch menghapus klaim processor dan flag kartu dari konfigurasi semata | Jangan mengaktifkan kartu hanya untuk reviewer |
| Operasional: gateway lain benar-benar live | TokoPay/USDT dan checkout | NEEDS_OWNER_CONFIRMATION | API checkout publik anonim menawarkan IDR/TokoPay, Binance internal, Bybit internal dan BSC; bukan bukti settlement. PayDisini/NOWPayments false pada snapshot | Owner cocokkan dashboard/provider; audit tidak membuat pembayaran live |
| Teknis: katalog tetap transparan | Listing/search/product | PASS | Tidak ada kategori yang dihapus/disembunyikan untuk reviewer; copy tidak menjanjikan kategori baru | Isi deskripsi masing-masing SKU sesuai fakta |
| Teknis: fulfillment per keluarga | Game vs aplikasi | PASS | Copy top-up/player status berbeda dari stok akun/manual/aktivasi; tes local game/premium/legacy | SLA provider dan tiap paket tetap perlu pemantauan operasional |
| Legal: hak penjualan merek/akun | Brand game, premium apps bila dijual | NEEDS_OWNER_CONFIRMATION | Repository/config bukan bukti hak distribusi | Siapkan sumber stok, syarat supplier/brand, izin yang relevan; tanyakan Xendit bila tidak jelas |
| Legal: wallet/stored value dan USDT | `/wallet/topup`, rail crypto | NEEDS_OWNER_CONFIRMATION | Saldo IDR/USDT dan pembayaran crypto nyata di sistem; S&K Xendit bagian 11 perlu penilaian | Owner/penasihat/Xendit menilai model; tidak menyembunyikan fitur |
| Legal: refund/garansi/privacy final | `/terms`, `/privacy`, `/refund` | NEEDS_OWNER_CONFIRMATION | Draft faktual dan diff ada di `legal-review.md`; SLA 7 hari/1×24/instan sebelumnya tidak terverifikasi | `LEGAL_REVIEW_REQUIRED`: setujui teks, nominal/metode/tenggat refund, retensi dan praktik data |
| UX rekomendasi: footer compact/keyboard | Footer/header/drawer | PASS | Disclosure mobile tertutup, relationship/state ARIA, policy links permanen, identitas tidak tersembunyi | Bukan persyaratan desain resmi Xendit |
| SEO/security: private tidak terindeks | Account/reset/order/pay/track | PASS | noindex; canonical private dihapus, tidak ada OG order data; sitemap publik saja | Robots bukan pengganti auth; ownership API dipertahankan |
| Kualitas: build/typecheck/unit/browser | Kode worktree | PASS | Typecheck penuh + 598 file/11.121 tes lulus; lint/build dan 6 skenario browser unik lulus | Bukti dan batas cakupan di `validation-results.md`; ulangi smoke setelah rilis yang disetujui |
| Rekomendasi: sampel performa/kontras lokal | Homepage + token footer | PASS | LCP/CLS awal dicatat pada 390/1440px, tanpa throttle; kontras legal footer 5,29:1 | Sampel terbatas; bukan klaim CWV/WCAG produksi |
| Performa lapangan / WCAG menyeluruh | Situs live di perangkat nyata | BLOCKED | Tidak ada RUM/CrUX/lighthouse, INP lapangan atau audit WCAG formal pada task ini | Uji lapangan terpisah; tidak mengklaim CWV/WCAG lulus |
| Keputusan aktivasi merchant | Dashboard Xendit | BLOCKED | Review belum berlangsung/selesai menurut owner | `XENDIT_DECISION_PENDING`; tidak ada jaminan penerimaan |

Referensi resmi: [kriteria situs](https://help.xendit.co/hc/id/articles/4405784216973-Apa-saja-kriteria-situs-web-atau-aplikasi-untuk-registrasi),
[S&K Indonesia bagian 11](https://www.xendit.co/id/syarat-dan-ketentuan/),
[penolakan/aktivasi](https://help.xendit.co/hc/en-us/articles/4801728966553-Why-my-application-was-rejected-What-to-do-next),
[dokumen merchant Indonesia](https://help.xendit.co/hc/en-us/articles/10891368765593-ID-What-are-the-legal-documents-required-to-register-to-Xendit-for-Indonesian-Merchants).

`TECHNICALLY_READY`: cakupan patch lokal lulus gate penuh dan pengujian browser.
`NEEDS_OWNER_VERIFICATION`: kebijakan final, hak distribusi, gateway live dan
wallet/USDT masih memerlukan tindak lanjut owner. Identitas sudah dikonfirmasi.
`XENDIT_DECISION_PENDING`: merchant belum aktif dan keputusan tetap milik Xendit.
Status kode lokal tidak berarti website live sudah diperbarui atau merchant disetujui.
