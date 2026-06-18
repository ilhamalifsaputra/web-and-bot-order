# Phase 12 — Configuration Audit

> Read-only.

---

## Konteks Proyek
`packages/core/src/config.ts` (~209 loc) memvalidasi env dengan **zod** (tipe, default,
transform; gagal cepat bila salah). **DB sebagai sumber kebenaran runtime** (bot token,
admin id) — perubahan via web-admin dihormati lintas proses (plan `singletruth.txt`).
Setup wizard web-admin: `/setup/bot`, `/setup/owner`, `/setup/shop`, `/setup/restart`
(`apps/web-admin/src/routes/setup.ts`).

---

## Objective
Permudah onboarding: env bersih, setup sinkron dengan perilaku nyata.

## Langkah Investigasi
1. **Env terpakai vs tidak:** daftar key di `config.ts`; untuk tiap key `grep -rn "config\.<KEY>" apps packages`. Tandai yang nol-hit (kandidat hapus) & yang dipakai tapi tak ada di config (risiko undefined).
2. **Sinkron `.env` ↔ README ↔ config:** bandingkan contoh `.env` di README §2 dengan `config.ts`. Ada yang hilang/usang?
3. **Wizard vs efek nyata:** baca `routes/setup.ts` — apakah `/setup/restart` benar memuat ulang config/identitas? Apakah langkah wizard menggambarkan akibat sebenarnya (mis. "perlu restart")?
4. **Duplicate config:** nilai sama didefinisikan di dua tempat (config + hardcoded).
5. **Hardcoded value:** `grep -rniE "(localhost|127\.0\.0\.1|http://|:8[0-9]{3}|TODO|FIXME)" apps packages --include=*.ts | grep -v test` → nilai yang seharusnya env.
6. **Setup flow:** urutan & prasyarat jelas? pesan error membantu?

## Output → tulis ke `audit/reports/phase-12-configuration.md`
```
ID | Kategori (unused-env / missing-env / wizard-desync / duplicate / hardcoded / flow) | File:line | Temuan | Rekomendasi | Prioritas
```
Plus rekomendasi ringkas "langkah onboarding ideal".
