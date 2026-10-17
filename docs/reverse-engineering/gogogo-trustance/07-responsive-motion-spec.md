# 07 — Spesifikasi responsif dan gerak

Pengukuran referensi di 1440, 1280, 1024, 768, 390, 360 (home dan Mobile Legends). OBSERVED.

| Viewport | Home | Top-up ML |
|---|---|---|
| 1440 / 1280 | pencarian inline, tanpa tab bar bawah, tanpa overflow | bar checkout fixed 1024x99 di tengah |
| 1024 | pencarian inline, tanpa overflow | bar checkout 1009x99 |
| 768 | pencarian inline hilang; tab bar bawah fixed 753x96 | bar 753x99 |
| 390 | tab bar 375x96; tanpa overflow | bar 375x98, grid nominal 2 kolom |
| 360 | tab bar 345x96; overflow horizontal 1 px (bug referensi, tidak ditiru) | bar 345x98 |

Breakpoint efektif: pencarian inline hilang di bawah `md` (768); tab bar bawah tampil di bawah `lg` (1024).

## Gerak
Durasi/easing carousel dan transisi tab tidak terukur (UNKNOWN). Untuk Trustance: transisi singkat, hormati `prefers-reduced-motion`, carousel punya tombol pause dan tidak autoplay tanpa kontrol.
