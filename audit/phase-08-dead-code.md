# Phase 8 — Dead Code Audit

> Read-only. **Hanya identifikasi — jangan menghapus apa pun.**

---

## Konteks Proyek
Monorepo pnpm+TS; `pnpm -r typecheck` hijau (import mati fatal akan ketahuan TS).
Tooling tersedia: grep, `pnpm why <pkg>`. Catatan: file plan tercecer di root
(`singletruth.txt`, `postdev.md`) — bukan kode. Route bulk `/catalog/group/:id/assign`
sudah dihapus (commit 4bfb389).

---

## Objective
Temukan kode/aset/konfig tak terpakai, klasifikasikan tingkat keyakinan.

## Langkah Investigasi
1. **Unused exports/functions:** untuk fungsi crud/util yang dicurigai, `grep -rn "namaFungsi" apps packages --include=*.ts | grep -v "definisinya"` → nol pemakaian = kandidat.
2. **Unused routes/API:** daftar route (`grep -rn "app.\(get\|post\|put\|delete\)"`) lalu cek apakah ada link/form/`fetch` yang memanggilnya di `.njk`/JS.
3. **Unused macro/template njk:** `grep -rn "import .*_shop\|_macros\|include " apps/*/views` vs macro yang didefinisikan.
4. **Unused import:** andalkan TS/ESLint (`noUnusedLocals`) bila aktif; atau spot-check file besar.
5. **Unused env:** bandingkan key di `packages/core/src/config.ts` dengan pemakaian (`grep -rn "config\.<KEY>"`).
6. **Unused dependency:** untuk tiap dep di `package.json`, `grep -rn "from \"<pkg>\"\|require(\"<pkg>\")"`. Bantu dengan `pnpm why <pkg>`.
7. **Aset tercecer:** file di root/`data/` yang bukan bagian build (mis. `singletruth.txt`).

## Output → tulis ke `audit/reports/phase-08-dead-code.md`
Dua daftar terklasifikasi:
- **Safe to remove** — yakin tak terpakai (sertakan bukti grep nol-hit).
- **Need verification** — perlu cek manual / mungkin dipakai dinamis.
```
Item | Tipe (file/fn/route/import/env/dep/aset) | Bukti | Klasifikasi | Catatan
```

## Constraint
Jangan menghapus apa pun di fase ini.
