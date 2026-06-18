# 00 — Release Manager / Execution Playbook

## ROLE
Technical Lead / Senior Software Architect (Release Manager).

## OBJECTIVE
Mengubah laporan audit (`audit/reports/phase-15-production-readiness.md` + fase 00–14, 16)
menjadi **playbook eksekusi bertahap** zero-regression: sprint, dependency graph, urutan PR,
blast radius, Definition of Done. **Bukan** memperbaiki kode.

## GLOBAL RULES
- Minimal patch, zero regression, preserve existing behavior.
- Jangan refactor besar tanpa alasan; jangan ubah API publik tanpa alasan.
- Tiap sprint: `pnpm -r typecheck` + `npx vitest run` hijau sebelum merge.
- Satu PR per issue (atau cluster yang bergantung erat). Dokumentasikan tiap perubahan.

## INPUT (issue audit, sumber phase-15)
High: H-1, H-2, H-3, H-4 · Medium: M-1..M-9 · Low: L-1..L-10 · Tech debt: A-01..A-05.

## ANALYSIS (cari)
- Root cause & blast radius tiap issue (lihat file 01–13).
- Ketergantungan antar-issue (mana harus duluan).
- Risiko regresi & failure scenario per cluster.

## IMPLEMENTATION STRATEGY
1. Baca ulang phase-15 (sumber kebenaran issue).
2. Petakan owner-file (01–13), blast radius, test terdampak.
3. Susun dependency graph + urutan PR.
4. Tetapkan DoD per sprint + exit criteria rilis.

## WRITING PLAN (yang akan kamu tulis)
Hasil = dokumen rencana `execution/PLAN.md` (atau output sesi) berisi:
1. **Sprint board** — Sprint 1 (H-*), Sprint 2 (M-*), Sprint 3 (L-* + A-*), tiap item: owner-file, effort S/M/L.
2. **Dependency graph** (Mermaid) + daftar "X sebelum Y, alasan". Minimal:
   - `H-3 (CI)` prasyarat semua (gate regresi) → pertama.
   - `H-2` ⊇ `L-01` (Fastify logger:false) → file 11.
   - `M-9` → file 07 (config) + file 08 (payment).
   - `M-5` ↔ file 06 ↔ file 12 (DOC-02).
   - `M-2/M-3` → file 05 (benchmark).
   - `A-04` setelah M-2/M-3 (hindari konflik di `crud/catalog.ts`).
3. **Tabel urutan PR**: PR# | issue | file owner | blast radius | test terdampak | risiko | DoD.
4. **DoD per sprint** + **exit criteria rilis publik**.

## EXECUTION PLAN (langkah konkret, siap jalan)
1. `git checkout master && git pull` lalu buat branch koordinasi bila perlu.
2. Verifikasi baseline hijau: `pnpm -r typecheck` && `npx vitest run` (catat jumlah test sebagai baseline regresi).
3. Tulis `execution/PLAN.md` sesuai WRITING PLAN.
4. Urutan eksekusi rekomendasi (validasi ulang):
   `03 (CI) → 01 (H-1) → 02 (H-2,M-5,M-8) → 04 (H-4,M-1) → 05 (M-2,M-3) → 08 (M-9)+07 (M-7) → 06 (M-5) → sisanya (M-4,M-6) → 09/10/11/12 → 13 (post-release)`.
5. Untuk tiap PR: buat branch `git checkout -b fix/<id>-<slug>`, serahkan ke file owner, gate dengan typecheck+vitest, review, merge.
6. Setelah Sprint 1: jalankan file `13` (smoke/rollback/monitoring) sebelum rilis.

## OUTPUT
`execution/PLAN.md`: sprint board, dependency graph, tabel urutan PR, DoD per sprint, exit criteria.

## CONSTRAINT
Jangan menghasilkan patch / mengubah file project. Hasil = playbook eksekusi setara architect senior.
