# Laporan Phase 8 — Dead Code Audit

Tanggal: 2026-06-18 · Read-only. Tidak menghapus apa pun.

## Safe to remove
```
Item | Tipe | Bukti | Catatan
singletruth.txt | aset/plan tercecer | file plan "Single Source of Truth" di root, untracked, bukan kode | pindah ke docs/ atau hapus
postdev.md | aset/plan | rencana audit (sumber fase ini), untracked | simpan/relokasi sesuai selera; sudah dipecah ke audit/
```

## Need verification
```
Item | Tipe | Bukti | Aksi verifikasi
crud searchProductsWithCategory | fungsi | route /search kini pakai searchCatalogEntries; fungsi lama mungkin tak terpakai | `grep -rn "searchProductsWithCategory" apps packages --include=*.ts` → bila hanya definisinya, hapus
crud card()/listActiveProductsWithCategory dll | fungsi | sebagian crud katalog lama mungkin tinggal dipakai 1 tempat | cek pemakaian per fungsi sebelum hapus
storefront routes/catalog.ts card() | helper lokal | duplikat shapeEntries (lihat A-04) | gabung, bukan hapus mentah |
```

## Yang BUKAN dead (terverifikasi terpakai)
- Dependency: `luxon`, `nodemailer`, `croner`, `@grammyjs/runner`, `dotenv` — semua dipakai (grep > 0).
- Env spot-check: `REFERRAL_COMMISSION_PERCENT`, `PUBLIC_CHANNEL_ID`, `SUPPORT_GROUP_ID`, `LOW_STOCK_THRESHOLD` — dipakai.
- Route bulk `/catalog/group/:id/assign` sudah dihapus (commit 4bfb389) — bukan lagi temuan.

## Catatan
`pnpm -r typecheck` hijau → tak ada unused-import fatal. Untuk unused exports yang halus, jalankan verifikasi grep per simbol sebelum menghapus (dynamic usage di template/registrasi route bisa luput dari TS).

> Read-only — hanya identifikasi.
