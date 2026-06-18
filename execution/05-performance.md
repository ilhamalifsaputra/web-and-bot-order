# 05 — Performance

## ROLE
Performance Engineer.

## OBJECTIVE
Hilangkan bottleneck baca katalog tanpa ubah perilaku: batasi query search (M-2) & cache (M-3),
dengan bukti benchmark before/after.

## GLOBAL RULES
- Minimal patch, zero regression (output & urutan identik). Ukur dulu, baru ubah (YAGNI). Test bila query berubah.

## INPUT (issue audit)
- **M-2** — `searchCatalogEntries` tanpa `take` (cap di memori). (P5-01, `packages/db/src/crud/catalog.ts:468-490`)
- **M-3** — Render katalog scan penuh tiap request (tanpa cache). (P5-02, `:391-415`, `:429-450`)

## ANALYSIS (cari)
- M-2: `matchedProducts`/`groupsByName` `findMany` tanpa `take`; pemotongan setelah shaping. Side effect `take` terlalu kecil → kartu grup berkurang → pilih `take = limit * faktor` + verifikasi parity via `product_groups.test.ts`.
- M-3: grid Home/kategori rebuild tiap request; cache = TTL pendek per-proses atau invalidasi-on-write (create/update/assign produk). Risk: stale → invalidasi pada mutasi katalog.
- Jangan regресi: badge sudah map (no N+1).

## IMPLEMENTATION STRATEGY
1. Benchmark baseline (dataset 1k/10k produk sintetis).
2. M-2: tambah `take`; jalankan test crud → output identik.
3. M-3: rancang cache hanya bila benchmark membuktikan perlu; jaga invalidasi.
4. Benchmark after; bandingkan; korektnes identik. Dokumentasikan.

## WRITING PLAN
- **File diubah:** `packages/db/src/crud/catalog.ts` (`searchCatalogEntries` → tambah `take`). M-3 (opsional): modul cache kecil `packages/db/src/crud/_catalogCache.ts` + invalidasi di `createProduct/updateProduct/assignProductToGroup`.
- **Test:** `packages/db/src/crud/product_groups.test.ts` — tambah kasus dataset besar memastikan parity hasil & `take` tak memotong kartu grup yang valid.
- **Artefak:** `execution/bench/` skrip seed + ukur (di luar app, untuk benchmark).
- **Docs:** catat angka before/after + keputusan M-3 (terapkan/ditunda).

## EXECUTION PLAN (siap jalan)
1. `git checkout -b perf/m2-search-take`
2. Tulis skrip seed sintetis (mis. `tsx execution/bench/seed.ts`) → 10k produk + beberapa grup.
3. Ukur baseline: latency `/search?q=a` (p50/p95), jumlah row dibaca, memori.
4. Tambah `take: limit * 4` di query match `searchCatalogEntries`; `npx vitest run packages/db/src/crud/product_groups.test.ts` → hijau & output identik dataset uji.
5. Ukur after; bandingkan; pastikan korektnes sama.
6. M-3 hanya jika p95 render Home masih tinggi: implement cache TTL + invalidasi; benchmark ulang.
7. `pnpm -r typecheck && npx vitest run` full hijau.

## OUTPUT
- **Benchmark plan**: dataset, metrik (p50/p95, query count, memori), skrip, kriteria sukses (p95 turun, korektnes identik). Rekomendasi: M-2 sekarang; M-3 bila terbukti perlu.

## CONSTRAINT
Jangan langsung mengubah kode. Hasilkan benchmark plan + keputusan berbasis ukuran.
