# Proposal Cloudflare dan origin

Status: proposal repository, belum diterapkan. Domain aktual, paket Cloudflare, DNS orange cloud, firewall dan konfigurasi nginx terpasang tidak tersedia dalam audit. Pemilik perlu menyetujui perubahan produksi, termasuk purge cache.

## Cache privat terlebih dahulu

Gunakan Cache Rule **Bypass cache** untuk `starts_with(http.request.uri.path, "/uploads/tickets/")`, serta `/api/` dan halaman akun/pembayaran bila ada aturan Cache Everything. Terapkan untuk host storefront dan admin. Purge seluruh attachment legacy yang pernah tercache; jangan memasukkan cookie/session/token ke cache key sebagai pengganti bypass. Backend kini mengirim private/no-store dan memeriksa owner/admin. Exception nginx tersedia di `deploy/nginx/telegram-shop.conf`; validasi `nginx -t` di staging sebelum reload produksi. Uji anonim sesudah cache dipanaskan oleh owner: tetap404, tidak menerima file owner. [Dokumentasi Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

## Rute dan rate limiting

Ganti `shop.example.com` dengan hostname SHOP_PUBLIC_URL. Ekspresi berikut memakai path nyata dalam repo; validasi sintaks/fitur di dashboard zone sebelum menyimpan. Tidak memakai regex atau bot-score berbayar.

```text
(http.host eq "shop.example.com" and http.request.method eq "POST" and
 http.request.uri.path in {"/api/v1/checkout" "/api/v1/topup/order" "/api/v1/wallet/topup"})
```

Usulan awal edge:30 request/IP/60detik, block singkat dengan respons429 bila paket mendukung. Ini agregat publik, bukan kuota guest5: edge tidak dapat mempercayai email atau cookie client sebagai identitas verified. Backend tetap membedakan guest dan customer. Pantau NAT dan trafik sah sebelum enforcement; backend sudah menerapkan quota, jangan mengganti validasi invoice dengan WAF.

```text
(http.host eq "shop.example.com" and http.request.method eq "POST" and
 (http.request.uri.path in {"/api/v1/account/support" "/api/v1/account/support/new"} or
  starts_with(http.request.uri.path, "/api/v1/account/support/")))
```

Usulan edge45/IP/60detik untuk reply/operasi support; backend create3/account dan IP9/60detik, reply15/account dan IP45/60detik. Angka edge wajib dituning; block seluruh prefix juga menghitung close/reopen. Rule auth dapat memakai exact paths `/api/v1/auth/login`, `/api/v1/auth/register`, `/api/v1/auth/forgot`, `/api/v1/track`, dengan baseline5/IP/menit untuk login saja. Jangan agregasikan semua auth ke satu kuota5 tanpa mengukur perjalanan user. Parameter period, action dan jumlah rule bergantung paket; bila tidak tersedia gunakan proteksi backend dan monitoring yang ada, tanpa menambah layanan. [Dokumentasi rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Pengecualian integrasi

Jangan beri browser challenge/Turnstile/rule checkout pada `/pay/tokopay/callback`, `/pay/paydisini/callback`, `/pay/nowpayments/callback`, `/pay/digiflazz/callback`, `/tg/<secret>`, `/healthz`, `/static/*` dan SSE order. Ekspresi exact checkout di atas tidak mencocokkan callback. Bila managed rule menyebabkan false positive pada provider, skip hanya rule/phase yang terbukti, bukan seluruh keamanan zone. Signature dan state guard backend tetap wajib. Jangan menganggap request sah hanya karena datang dari Cloudflare.

Managed Challenge lebih sesuai navigasi HTML dengan sinyal abuse yang terukur, bukan fetch JSON/multipart yang akan menerima HTML challenge. Turnstile adaptif masih backlog: memerlukan integrasi verifikasi backend, fallback aksesibilitas, dan uji UX staging; tidak dipasang dalam patch ini.

## Proxy dan origin

Verifikasi DNS web/API proxied secara manual di dashboard. Periksa socket peer yang dilihat Fastify; TRUST_PROXY harus daftar hop nginx/Cloudflare yang benar-benar dipercaya. Jangan mengizinkan0.0.0.0/0, `true`, atau sembarang CF-Connecting-IP. Nginx harus memperoleh client IP hanya dari upstream tepercaya; jika menggunakan real_ip_header CF-Connecting-IP, set_real_ip_from wajib hanya rentang Cloudflare resmi dan origin wajib dibatasi. Jangan menyalin header tanpa trust chain.

Pilih Cloudflare Tunnel, Authenticated Origin Pulls, atau allowlist firewall sesuai deployment yang sudah ada. Pertahankan akses SSH/operator terpisah dan rencana recovery sebelum menutup origin. Cek IPv4/IPv6, port Node/PostgreSQL/admin/debug/backup dan publikasi Docker; contoh compose bukan bukti keadaan VPS. [Dokumentasi perlindungan origin](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/).

## Rollout dan rollback

Ekspor konfigurasi zone/nginx sebelum perubahan. Mulai staging, tinjau analytics atau mode log bila paket mendukung, lalu satu rule sekaligus setelah approval pemilik. Pantau429, false positive NAT, payment pending, callback retry dan preview ticket. Rollback dengan menonaktifkan rule baru/restore config terverifikasi; pertahankan cache bypass dan authorization ticket. Jangan membuka attachment publik untuk menyelesaikan masalah preview. Tidak ada perubahan DNS/WAF/firewall yang dijalankan oleh audit ini.
