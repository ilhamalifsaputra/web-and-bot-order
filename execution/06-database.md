# 06 — Database (Backup & Restore)

## ROLE
Database Engineer (DBA).

## OBJECTIVE
Strategi backup & restore SQLite (WAL) konsisten & teruji (M-5) + disiplin migrasi aman. Tanpa ubah schema.

## GLOBAL RULES
- Jangan ubah schema di tugas ini. Backup WAL-safe; restore teruji. Dokumentasikan + rollback.

## INPUT (issue audit)
- **M-5** — Backup SQLite saat WAL bisa inkonsisten. (DO-05/DOC-02)
- Konteks: D-01 (migrasi aman, risiko `P2022`), D-02 (single-writer).

## ANALYSIS (cari)
- `data/bot.db`, `journal_mode=WAL` (`packages/db/src/client.ts:32`). Copy mentah saat WAL aktif → bisa lewatkan transaksi di `-wal`/`-shm`.
- Aman: `sqlite3 data/bot.db ".backup '/path/backup.db'"` (online, atomic) atau stop→copy `.db`+`-wal`+`-shm`→start.
- Restore: tempatkan file, `chown app:app` (selaras Docker entrypoint), `PRAGMA integrity_check`, smoke test.
- D-01: kolom non-null tanpa default → `P2022`; pola 2-langkah (nullable→backfill→non-null) + `prisma db push` sebelum kode baru.

## IMPLEMENTATION STRATEGY
1. Metode backup utama (`.backup`) + jadwal + retensi.
2. Prosedur restore + verifikasi (`integrity_check` + smoke).
3. Uji end-to-end di staging (backup → replace → restore → app sehat).
4. Dokumentasikan disiplin migrasi aman. Rollback = restore backup terakhir.

## WRITING PLAN
- **Artefak baru (ops):** `deploy/backup/backup.sh`, `deploy/backup/restore.sh`, entri cron, `deploy/backup/README.md` (RTO/RPO, retensi, lokasi off-box).
- **Docs:** perbarui README §7 (lihat file 12 DOC-02) → ganti "copy satu file" jadi `.backup`.
- **Tidak ada perubahan schema/kode.**

## EXECUTION PLAN (siap jalan)
1. Tulis `backup.sh`: `sqlite3 "$DB" ".backup '$DEST/bot-$(date +%F-%H%M).db'"` + rotasi retensi + (opsional) upload off-box.
2. Tulis `restore.sh`: stop service → salin backup ke `data/bot.db` (+ hapus `-wal`/`-shm` basi) → `chown app:app` → `sqlite3 data/bot.db "PRAGMA integrity_check;"` → start → smoke `/healthz`.
3. Jadwalkan cron (mis. tiap 6 jam) di host/compose.
4. **Uji end-to-end di staging:** ambil backup → rusak/replace DB → jalankan `restore.sh` → app sehat & data utuh.
5. Catat RTO/RPO aktual + lampirkan disiplin migrasi aman (D-01).

## OUTPUT
- **Backup strategy** (perintah, jadwal, retensi, off-box, enkripsi opsional) + **Restore strategy** (langkah, integrity check, RTO/RPO, uji berkala) + catatan migrasi aman.

## CONSTRAINT
Jangan mengubah schema/kode. Hasilkan backup & restore strategy + prosedur teruji.
