# 00 — Lingkungan dan cakupan

Tanggal investigasi: 2026-10-17. Label bukti: `OBSERVED` (diukur di browser), `INFERRED` (dugaan), `UNKNOWN`.

## Tool yang benar-benar tersedia
| Kebutuhan | Tool | Status |
|---|---|---|
| REA (`rea-agents`) | tidak dipasang; tidak dicoba setup | UNKNOWN, tidak diklaim berhasil |
| Navigasi, DOM snapshot, computed style, screenshot, viewport | Playwright MCP (`mcp__playwright__*`) | OBSERVED, dipakai |
| Network | `browser_network_requests` | dipakai; tidak ada XHR/API yang cocok (lihat 06) |
| Docker | tidak berjalan; dilarang user | Postgres lokal embedded (port 5544) untuk worktree |

## URL referensi yang diperiksa
- Home: https://gogogo.com/id-id
- Top-up: `/id-id/p/topup/mobile-legends-games` (User ID + Zone ID)
- Top-up: `/id-id/p/topup/uc-pubgm-indonesia-games` (User ID saja)
- Belum dibuka live: `/p/topup/honor-of-kings-games`, `/p/voucher/playstationstore-gift-card-games`.

## Viewport yang sudah dicakup
1440x900 (home penuh, ML penuh, token) dan 390x844 (ML viewport + pengukuran). 1280, 1024, 768, 360 belum.

## Repo
Worktree `worktree-gogogo-ui` dari `master` 82f0a107, `.env` port 8209/8210, DB `gogogo_ui` di Postgres embedded lokal, skema sudah `db push`.

## Batas
Tidak ada transaksi, tidak ada pengisian ID, tidak ada API privat, tidak ada aset/kode Gogogo yang disalin. Screenshot di `assets/` hanya bukti referensi internal.
