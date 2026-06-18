# 07 — Configuration (Single Source of Truth)

## ROLE
Backend Engineer.

## OBJECTIVE
Perjelas & dokumentasikan presedensi config env-vs-DB sehingga ada satu sumber kebenaran yang jelas (M-7).

## GLOBAL RULES
- Minimal patch, zero regression, preserve behavior. Jangan ubah perilaku resolusi config tanpa alasan kuat. Dokumentasikan.

## INPUT (issue audit)
- **M-7** — Presedensi config env-vs-DB tak terdokumentasi (mis. `BOT_TOKEN` env vs `Setting` DB). (C12-02/DOC-01)

## ANALYSIS (cari)
- `packages/core/src/config.ts` (zod, env) vs tabel `Setting` (DB, sumber runtime — plan `singletruth.txt`).
- Identifikasi identitas yang punya dua sumber: bot token, admin ids, FX rate, dll. Tentukan **mana yang menang** secara aktual di kode (`resolveAdminIds`, `botToken()`, `resolveWebCookieSecret`, dll).
- Failure: admin ubah setting di web tapi proses pakai env lama → kebingungan; cek apakah perlu restart (kaitkan C12-01 wizard restart).

## IMPLEMENTATION STRATEGY
1. Telusuri tiap setting bersumber-ganda; petakan resolver (env default vs DB override) di `apps/server`/`packages/db`.
2. Tetapkan aturan presedensi eksplisit (rekomendasi: **DB > env** untuk identitas runtime; env sebagai bootstrap/default).
3. Bila kode sudah konsisten → cukup dokumentasikan. Bila tidak konsisten → patch minimal agar satu aturan.
4. Dokumentasikan tabel "sumber kebenaran per setting".

## WRITING PLAN
- **Analisis (tanpa ubah kode dulu):** daftar setting + resolver + presedensi aktual.
- **Docs:** tabel "Sumber Kebenaran per Setting" di `DOCS.md` (key | env | DB | yang menang | perlu restart?). Koordinasi file 12 (DOC-01).
- **Patch (hanya bila inkonsisten):** samakan resolver di `packages/db`/`apps/server`; tambah test resolusi.

## EXECUTION PLAN (siap jalan)
1. `grep -rn "getSetting\|config\.\|resolveAdminIds\|botToken\|resolveWeb" apps/server packages/db/src --include=*.ts` → petakan resolver tiap setting bersumber-ganda.
2. Tentukan presedensi aktual per setting; tandai yang tidak konsisten.
3. Tulis tabel sumber-kebenaran (untuk `DOCS.md`).
4. Bila ada inkonsistensi: `git checkout -b fix/m7-config-precedence`, samakan resolver (patch minimal), tambah unit test (`packages/db/src/crud/*setup*`/`settings`), `npx vitest run`.
5. Bila sudah konsisten: tidak ada perubahan kode — hanya dokumentasi.

## OUTPUT
- **Single source of truth:** tabel presedensi per setting + aturan tertulis (DB>env atau sebaliknya) + catatan restart (C12-01).

## CONSTRAINT
Jangan refactor config besar. Hasilkan dokumen sumber-kebenaran + patch minimal hanya bila ada inkonsistensi nyata.
