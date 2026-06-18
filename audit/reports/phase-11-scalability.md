# Laporan Phase 11 — Scalability Audit (asumsi user ×100)

Tanggal: 2026-06-18 · Read-only.

## Current scaling limitations (urut dampak)
```
# | Batas | Komponen/File | Gejala @×100 | Mitigasi | Pemicu
1 | SQLite single-writer | packages/db (semua tulis) | kontensi tulis pada checkout serempak → latensi/timeout (busy_timeout 5s) | migrasi PostgreSQL | ≥2 concurrent writer nyata (RUN.md §9)
2 | Tanpa cache read | render Home/kategori/search query DB tiap request (crud/catalog.ts scan) | beban baca tinggi di SQLite | cache read (in-memory/Redis) untuk katalog; + take pada search (P5-01) | trafik baca tinggi / katalog besar
3 | Queue berbasis tabel DB | notification_outbox, broadcasts (drain via job bot) | throughput notifikasi terbatas; menambah beban writer | broker khusus (Redis/BullMQ) | volume notifikasi/broadcast besar
4 | Single Node process | apps/server (semua app 1 proses) | 1 titik gagal; batas CPU; webhook+web+bot+jobs berbagi event loop | pisah proses / horizontal scale (butuh Postgres dulu) | CPU jenuh / kebutuhan HA
5 | Query unbounded | crud/catalog.ts (search/list), reports.ts | memori naik dgn ukuran data | take/paginasi/agregasi (lihat P5) | data tumbuh
```

## Yang sudah membantu ✅
- Rate-limit bot per-user; window pembayaran membatasi order menggantung.
- Paginasi pada order list admin.
- Index lengkap (Phase 6) → baca tetap efisien sampai batas writer.
- Transaksi pendek (Phase 5) → mengurangi durasi kunci writer.

## Rekomendasi roadmap
1. **Postgres** (buka jalan multi-writer & multi-proses) — fondasi semua scaling.
2. **Cache read katalog** + `take` pada search.
3. **Broker queue** bila notifikasi/broadcast jadi berat.
4. **Pisah proses** (web vs bot vs jobs) setelah Postgres.

> Read-only — tidak ada perubahan kode.
