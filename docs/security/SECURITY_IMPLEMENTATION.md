# Implementasi hardening

Perubahan terbatas pada batas auth/abuse/upload/recovery; tidak menambah dependency, Redis, migrasi DB atau provider service.

| Modul | Perubahan dan alasan |
|---|---|
| core/guestOrderAccess.ts + export | Token random192bit+HMAC, salt domain khusus, order code bound, TTL30hari, URL fragment; verifikasi timing-safe |
| storefront auth.ts/routes/auth.ts/plugins/auth.ts | Menyimpan orderScope signed; recovery tidak merge cart/adopt preferences; deny-by-default semua API selain baca exact order/status/SSE/context/logout; future timestamps ditolak |
| apiTrack.ts | Token wajib sebelum lookup; guest flag/banned diperiksa; generic404; origin dan quota lama tetap |
| api.ts, db/crud/orders.ts | Email guest checkout/fulfilled berisi private recovery link; order code tetap reference bisnis |
| apiCheckout/apiAccount, client types/TrackOrderPage/PayPage/OrderDetailPage/locales | Token input dapat paste/pre-filled fragment; fragment dibersihkan dari address bar; link tersedia juga tanpa SMTP pada sesi checkout asli; recovery tidak mendapat link baru; edit/cancel UI dibatasi |
| storefront/web-admin server.ts + db/ticketAccess.ts | Attachment same-origin cookie authorization; exact comma-boundary membership DB; admin readonly ditolak; normalized encoded/backslash path; no-store; HTTP malformed/oversized mempertahankan400/413 |
| admin plugins/auth.ts | Sesi yang memiliki JTI sah tetap harus berada di allowlist server saat request |
| rateLimit.ts, apiAccount.ts, apiWalletTopup.ts, core/config.ts | Sweep/kapasitas maps; IP /64; quota ticket sebelum multipart; Retry-After; validasi DTO ticket; reply lintas akun404; wallet submit berbagi cap checkout |
| ticketAttachments.ts | Batas parts/fields/fieldSize, filename128-bit; image magic yang lama dipertahankan |
| deploy/nginx/telegram-shop.conf | Proposal konfigurasi repository saja: exception ticket private/no-store di atas public uploads |
| tests | Tes boundary baru ditambah dan kontrak recovery lama dimigrasikan ke token; fixture suite tiket memiliki quota tinggi eksplisit agar tetap menguji kontrak, quota default diuji suite hardening |
| package.json, storefront/web-admin package.json, pnpm-lock.yaml | Versi Fastify5.12.5/static10.1.5; override busboy3.2.2/find-my-way9.9.0/proxy-addr2.0.8. Callback header static10 kini FastifyReply.header; dependency tidak ditambah |

Batas parser multipart memakai error ValidationError yang sudah dipahami klien untuk jumlah/ukuran lampiran; total body terlalu besar tetap413. Typecheck seluruh workspace, regression test dan build harus memakai dependency terkunci yang sama.

Header no-store juga ditetapkan dalam setHeaders final untuk file di direktori tickets: metadata static server menimpa header onRequest pada respons200. Regression owner/admin memastikan Cache-Control tetapprivate/no-store sesudah file dibaca, bukan hanya respons404.

Kompatibilitas: harga IDR/USDT, FX order snapshot, rounding, underpayment, overpayment, wallet ledger dan fulfillment tidak diubah. Bot memakai identitas update Telegram dan existing global throttle; tidak ada CAPTCHA atau pesan bot tambahan. Guest checkout tetap anonim dan memperoleh sesi normal. Pemulihan lintas perangkat sengaja berubah menjadi token-read-only satu order; pelanggan harus menyimpan tautan atau menggunakan email. Order reference/nomor tetap sama sehingga provider callback tidak perlu berubah.

Sesi recovery menggunakan JTI user yang sama: recovery merotasi sesi sebelumnya sesuai perilaku lama, dengan hak yang lebih sempit. Token stateless masih valid sampai30hari; tidak ada per-token revoke table. Untuk insiden token bocor perlu prosedur account conversion/secret rotation terkoordinasi. Output email/outbox memuat bearer link, sehingga akses database/outbox operator harus tetap terbatas.

Tidak ada enforce CSP baru: skrip inline/analytics opsional memerlukan inventory browser staging. Format video belum di-reencode/full parser; menjadi backlog P2. Domain, sertifikat, origin firewall, serta status orange cloud tidak disentuh.

## Remediasi dependency lanjutan

Seluruh33 advisory high produksi diselesaikan; audit produksi kini kosong (exit0). Nodemailer10.0.16, sharp0.35.5, kedua React Router7.18.4 dan override transitive patched terkunci. Shadcn CLI dihapus, stylesheet4.11.0 disalin byte-identik beserta lisensi ke admin src/styles dan import diarahkan lokal. Rincian33 advisory serta12 advisory tooling dev yang masih tersisa terdapat pada DEPENDENCY_REMEDIATION.md. Tidak menambah library/service.

Regresi suite lengkap menemukan metadata access-log route yang memuat concrete secret webhook; kedua host kini menyamarkan route melalui redactPath yang sama seperti path. Fixture overpayment/storage disesuaikan dengan allowlist nyata tes, tanpa melemahkan production guard.

## Remediasi tooling development lanjutan

Seluruh finding audit all diselesaikan: Vitest/coverage4.1.11, Vite6.4.3, esbuild0.28.2 dan selector-parser7.1.6. Project node/jsdom mempertahankan580file. Lifecycle mock disesuaikan tanpa melemahkanasersi. Minimum targetSafari keduaSPA kini14.1; browserlain tetap. Rincian dan bukti: DEVELOPMENT_TOOLING_REMEDIATION.md.
