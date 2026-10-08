# Remediasi dependency — 8 Oktober 2026

Permintaan lanjutan: selesaikan 33 advisory high yang tersisa pada audit dependency produksi fase pertama. Audit menggunakan pnpm 9.15.9 sesuai packageManager, tanpa ignore/mute advisory.

| Cakupan | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| Produksi sebelum | 0 | 33 | 35 | 4 |
| Produksi sesudah | 0 | 0 | 0 | 0 |
| Semua dependency sesudah, termasuk dev | 3 | 1 | 7 | 1 |

Audit produksi sesudah exit0, advisories kosong; dependency produksi turun dari587 menjadi300. Audit seluruh dependency exit1. Bukti mentah: dependency-audit-before.json, dependency-audit.json dan dependency-audit-all.json. Angka audit adalah advisory registry, bukan jumlah exploit yang telah terbukti reachable.

## Perubahan

- Nodemailer 10.0.16, sharp 0.35.5, react-router/react-router-dom 7.18.4 di kedua SPA. Helper SMTP memakai from/to/subject/text/html; tidak menerima raw message atau arbitrary attachments dari pelanggan. Nodemailer berpindah major; typecheck dan regresi wajib lulus, smoke SMTP staging tetap diperlukan sebelum deploy.
- Override branch kompatibel brace-expansion 1.1.21/2.1.7/5.0.12, fast-uri 3.1.8, js-yaml 4.3.2, postcss 8.5.23, nanoid3 3.3.18, browserslist 4.28.7, baseline-browser-mapping 2.11.0 dan source-map-js 1.2.2. Override server fase pertama tetap dipertahankan.
- Hapus dependency runtime shadcn CLI: satu-satunya penggunaan package adalah import CSS. Salin persis stylesheet shadcn4.11.0 ke src/styles/shadcn-tailwind.css, sertakan MIT license, lalu arahkan import lokal. Tidak memindahkan CLI ke devDependencies atau menekan advisory. Ini menghapus jalur shadcn ke undici/ip-address/braces/SDK MCP dan tooling server yang tidak dibutuhkan aplikasi. Braces tidak memiliki patch upstream pada advisory terkait; jalurnya dihapus seluruhnya.
- Tidak mengubah aturan nominal, rounding, ledger, provider callback, schema database, atau konfigurasi produksi. Node repository>=22.13 memenuhi engine dependency baru. Lockfile diperbarui memakai pnpm9; scripts install tidak dijalankan, Prisma client digenerate eksplisit.

## Seluruh 33 high baseline

RESOLVED berarti advisory baseline tidak terdapat lagi dalam audit produksi sesudah. Bisa melalui versi patched atau penghapusan jalur dependency; tidak mengklaim advisory mustahil di semua software lain.

| Modul | Advisory | Status audit produksi |
|---|---|---|
| brace-expansion | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | RESOLVED |
| js-yaml | [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | RESOLVED |
| fast-uri | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | RESOLVED |
| brace-expansion | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | RESOLVED |
| undici | [GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272) | RESOLVED |
| fast-uri | [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) | RESOLVED |
| ip-address | [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) | RESOLVED |
| brace-expansion | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | RESOLVED |
| js-yaml | [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | RESOLVED |
| react-router | [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | RESOLVED |
| nanoid | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) | RESOLVED |
| nanoid | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | RESOLVED |
| postcss | [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | RESOLVED |
| browserslist | [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) | RESOLVED |
| browserslist | [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | RESOLVED |
| nodemailer | [GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f) | RESOLVED |
| fast-uri | [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) | RESOLVED |
| fast-uri | [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) | RESOLVED |
| fast-uri | [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) | RESOLVED |
| sharp | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) | RESOLVED |
| js-yaml | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) | RESOLVED |
| nodemailer | [GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2) | RESOLVED |
| fast-uri | [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) | RESOLVED |
| fast-uri | [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) | RESOLVED |
| undici | [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | RESOLVED |
| undici | [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) | RESOLVED |
| brace-expansion | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | RESOLVED |
| brace-expansion | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | RESOLVED |
| nodemailer | [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) | RESOLVED |
| braces | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | RESOLVED |
| source-map-js | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | RESOLVED |
| sharp | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | RESOLVED |
| @modelcontextprotocol/sdk | [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) | RESOLVED |

## Advisory tooling tersisa

Berikut berada di graph dev/build/test: Vitest2/Vite5/esbuild, tinypool dan postcss-selector-parser. Bukan bagian33 high produksi yang diminta. Tidak disembunyikan melalui ignore. Migrasi Vitest4 membutuhkan perubahan konfigurasi environment/projects dan pengujian tersendiri; tidak dilakukan dalam remediation ini.

Docker saat ini memasang devDependencies untuk tsx/Prisma, sehingga audit --prod tidak membuktikan image bebas semua package rentan. Aplikasi tidak menjalankan Vitest UI atau Vite dev server di produksi, tetapi dependency tooling tetap perlu dihapus dari image atau di-upgrade dalam pekerjaan berikutnya. Jangan mengekspos dev server ke jaringan.

| Modul | Severity | Advisory |
|---|---|---|
| esbuild | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) |
| vite | moderate | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) |
| esbuild | low | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) |
| vite | moderate | [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) |
| vite | high | [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) |
| vitest | critical | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) |
| vitest | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) |
| @vitest/mocker | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) |
| postcss-selector-parser | moderate | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) |
| tinypool | critical | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) |
| tinypool | critical | [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) |

## Validasi

Hasil suite lengkap, typecheck, build, lint, guard dan instalasi frozen lockfile dicatat pada SECURITY_TEST_REPORT.md. Pengujian memakai PostgreSQL dummy localhost55479 dan provider mock, tanpa transaksi atau migrasi produksi. Tidak ada deploy dilakukan.

Referensi upstream: [braces tanpa patch](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [Nodemailer releases](https://github.com/nodemailer/nodemailer/releases), [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), [React Router advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2).
