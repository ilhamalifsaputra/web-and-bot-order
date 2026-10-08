# Remediasi seluruh tooling development

Permintaan lanjutan8 Oktober2026: tuntaskan seluruh temuan yang masih tersisa setelah33 high produksi diremediasi. Hasil audit terbaru seluruh dependency:0critical,0high,0moderate,0low, exit0; tidak ada mute/ignore advisory. Bukti: dependency-tooling-audit-before.json dan dependency-audit-all.json. Audit ini meliputi tooling yang turut dipasang Docker, bukan hanya filter --prod. Tidak ada deploy produksi.

## Baseline dan penghitungan

Metadata audit sebelum:3critical,1high,7moderate,1low (12findings). Detailadvisories berisi11entri paket/advisory dan10IDGHSAunik: esbuildmoderate muncul pada dua versi (0.24.2 dan0.21.5), sedangkan satuGHSA redirect-mock muncul pada vitest dan @vitest/mocker. Tidak mengarang advisory tambahan untuk menyamakan jumlahbaris denganmetadata.

| Paket | Severity sebelum | Advisory | Status audit all |
|---|---|---|---|
| esbuild | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | RESOLVED |
| vite | moderate | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | RESOLVED |
| esbuild | low | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | RESOLVED |
| vite | moderate | [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) | RESOLVED |
| vite | high | [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | RESOLVED |
| vitest | critical | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | RESOLVED |
| vitest | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | RESOLVED |
| @vitest/mocker | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | RESOLVED |
| postcss-selector-parser | moderate | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | RESOLVED |
| tinypool | critical | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) | RESOLVED |
| tinypool | critical | [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | RESOLVED |

## Implementasi

- Vitest dan @vitest/coverage-v8 dipin bersama pada4.1.11. Ini memperbaiki advisory UI/redirect-mock, mengganti Vite5 transitive, serta menghapus tinypool1 dan vite-node dari graph; tidak memaksa tinypool2 ke API library lama.
- Root Vite^6.4.3 menyediakan versi patched dalam major yang digunakan SPA. Semuaesbuild dipin0.28.2 (root,Vite,tsx), postcss-selector-parser major7 di-override7.1.6. Tidak ada suppress audit, dependency baru untuk menutupi temuan, atau patch manual node_modules.
- environmentMatchGlobs yang dihapus Vitest4 diganti2project extends:true: node349file dan frontend/jsdom231file. Alias, globals,20detiktimeout,BCRYPT_COST serta credentialdummy tetap diwariskan. Inventaris580file580unik dibandingkan dengangloblama: tidak ada missing/extra/duplicate. Coverageinclude eksplisit mempertahankan perhitungan sumber yang tidak di-import; threshold detection90% tetap.
- Vitest4 tidak lagi mereset vi.fn lewat restoreAllMocks dan mengembalikan spy yang sama saat spyOn dipanggil ulang. Lima fixture frontend kini resetAllMocks sebelum restore; spy fase request awal dan interaksi dipisahkan melalui mockClear. Tidak mengubah jumlahrequest,payload atau financial assertions. Timerfake dikembalikan pada afterEach; bulkvoucher menunggu hasilrefetch dirender agar queue tidak bocor antar-tes.
- esbuild baru memperbaiki data kompatibilitas dan menolak destructuring pada Safari14. Kedua build menetapkan target es2020/chrome87/edge88/firefox78/safari14.1. **Minimum Safari naik14 ke14.1**; browserlain tetapdefaultVite6. Tidak mengaktifkan flag supported palsu atau downgrade kecompiler rentan. Safari14.0 kini di luar target dukungan build; tidak ada klaim browserE2E padaSafari.

## Verifikasi

Hasil suiteakhir, typecheck, builds,lint,guards,frozenlockfile dan auditproduksi ada pada SECURITY_TEST_REPORT.md. CoverageV8baru lulus170tes/15file, dengan statements94.62%,branches94.08%,functions100%,lines94.53%; threshold tidak diturunkan. Build keduaSPA dan serverbundle lulus. Runmigrasi awal dihentikan saat menemukan incompatibilitymock; tidak dihitungPASS. Setelahperbaikan seluruhsuite dijalankan melalui kedua project yang membentukcakupan580file.

Referensi: [migrasi resmi Vitest4](https://raw.githubusercontent.com/vitest-dev/vitest/v4.1.11/docs/guide/migration.md), [project inheritance](https://raw.githubusercontent.com/vitest-dev/vitest/v4.1.11/docs/guide/projects.md), [esbuild0.28.2](https://raw.githubusercontent.com/evanw/esbuild/v0.28.2/CHANGELOG.md), [bug Safari pada compatibility table](https://github.com/compat-table/compat-table/commit/f36666b500c1a75bc10da62ee9658aad7c898d2c).
