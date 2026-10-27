# 03 — Token DOM/CSS bersama dan pemetaan ke Trustance

Semua nilai OBSERVED (computed style, 2026-10-17). Warna/brand Gogogo tidak disalin; kolom terakhir adalah keputusan adaptasi.

| Token/komponen | Nilai terukur | Padanan Trustance | Keputusan |
|---|---|---|---|
| Kontainer | maks 1250 px, margin auto | `Layout` `max-w-6xl` (1152 px) | Pertahankan `max-w-6xl`; tidak melebarkan situs |
| Header | `sticky top-0 z-30` (home), `z-50` (detail), tinggi ~53 px | `Navbar.tsx` | Pertahankan; cek z-index vs bar checkout (z-20) |
| Font | Red Hat Display 15 px/500 | Outfit, Manrope | Pakai font Trustance |
| h1 / h2 | 35.2 px bold / 24 px bold | skala heading Trustance | Pakai skala yang ada |
| Tab pill | tinggi 28–35 px, radius penuh, pad 10/16, aktif teks aksen | `components/ui/Tabs.tsx` | Reuse `Tabs`, token Trustance |
| Kartu poster | radius 8 px, `object-fit: cover`, `loading=lazy` | `ProductCard.tsx` | Reuse; tambah mode poster bila perlu |
| Kartu nominal | lebar 179 px, radius 8 px, 3 kol desktop / 2 kol mobile | `DenominationCard.tsx` (grid 2/3 kolom) | Kolom sudah sepadan |
| Bar checkout | `fixed bottom-0 inset-x-0 z-20`, maks 1024 px, tinggi 98–99 px | `StickyPurchaseBar.tsx` (mobile saja) | Jadikan tampil di semua viewport, hanya untuk template game |
| Tab bar bawah | `fixed`, tampil < 1024 px, tinggi 96 px | `MobileTabBar.tsx` | Sudah ada; cek tumpukan dengan bar checkout |

Aturan token repo: nilai baru hanya lewat `styles/tokens.extensions.css` dan dicatat di `docs/archive/implementation/extensions.md`; ESLint menolak nilai arbitrer.
