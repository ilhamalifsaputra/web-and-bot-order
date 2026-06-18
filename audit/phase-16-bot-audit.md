# Phase 16 — Bot Audit (grammY, lengkap end-to-end)

> **Read-only — jangan ubah kode.** Hanya temuan + rekomendasi.
> Deep-dive khusus `apps/order-bot`. Melengkapi (bukan menggantikan) Phase 1/2/4 —
> di sini fokusnya **bot sebagai produk utuh**: middleware chain, conversation
> engine, render/UX helper, callback router, jobs, dan poller pembayaran.

---

## Konteks Proyek
`apps/order-bot` = klien Telegram berbasis **grammY** (port dari PTB Python).
Komponen kunci:
- **Entry/wiring**: `src/main.ts` — `buildBot()` (konstruksi murni, aman di test) +
  `start()` (boot: initDb → token guard → command menu → jobs → `run()` runner →
  poller). Urutan middleware: `bindUpdateId` → `sequentialize(per-chat)` →
  `session` → `conversations()` → `registeredUser` → `rateLimit` → resume
  conversation → entry trigger → command → callback router (`/^v1:/`) →
  fallback `dead_tap` → `message:text` (input nomor produk).
- **Middleware**: `src/middleware.ts` — `registeredUser` (upsert user, sync
  `session.lang`, blokir banned), `rateLimit` (sliding-window in-memory `Map`),
  `adminOnly` (`isAdmin(ADMIN_IDS)`).
- **Context/session**: `src/context.ts` — `MyContext`, `initialSession`,
  `session.dbUser` snapshot.
- **Conversations**: `src/conversations/{admin,checkout,customer,reject,support}.ts`
  + `index.ts` (daftar `CONVERSATIONS` { name, fn, callback/command/hears }).
- **Handlers**: `src/handlers/{admin,callbacks,checkout,customer,static,verification}.ts`.
- **Render/UX helper** (`src/util/chat.ts`): `smartEdit` (customer), `adminEdit`
  (admin), `menuAnchor`/`adminAnchor` (wizard single-bubble), `retireKeyboard`
  (satu keyboard aktif), `consumeInput` (hapus input user yang sudah ditangkap).
- **Keyboards**: `src/keyboards/{admin,customer}.ts`. **i18n**: `src/util/i18n.ts`
  (`t(ctx,key,args)` / `coreT(key,lang,args)`) → `packages/core/locales/{en,id}.json`.
- **Jobs** (`src/jobs/index.ts`, croner, TZ-aware): auto-cancel order kadaluarsa
  (tiap menit), tutup tiket basi (tiap jam), reconcile finance (6 jam), broadcast,
  FX refresh.
- **Pembayaran** (`src/payments/{binanceInternal,bybitDeposit}.ts`): poller
  auto-confirm (Binance Internal Transfer, Bybit USDT-BSC deposit).
- **Error handling**: `bot.catch` global (`main.ts:116`) + `newErrorRef()`
  (`util/errors.ts`) — correlation id `ref` ke user & log.

**Aturan CLAUDE.md yang relevan (jadikan kriteria lulus/gagal):**
edit bubble bukan toast; satu keyboard aktif per chat; wizard single-bubble +
`consumeInput`; toast (sukses) vs alert (error/destruktif); **never strand the
user**; **no leaked English** (semua string lewat `t()`); **web tak pernah kirim
Telegram** (enqueue `notification_outbox`); **jangan log secret** (token,
payment-proof `file_id`, hash); money **Decimal**; UTC di DB + `localize` di
tampilan; audit tiap perubahan state via `logAdminAction`.

---

## Objective
Audit bot Telegram secara menyeluruh: kebenaran fungsional, ketahanan terhadap
penyalahgunaan/konkurensi, kepatuhan terhadap kontrak UX grammY di CLAUDE.md,
keamanan jalur admin & pembayaran, dan keandalan jobs/poller — sampai level
`file:line`, dengan severity dan rekomendasi yang dapat ditindak.

## Severity Rubric
- **Critical** — oversell/kebocoran dana, bypass `adminOnly`, eksekusi aksi admin
  oleh non-admin, kebocoran token/`file_id`, kehilangan/duplikasi order.
- **High** — flow rusak yang menjebak user/admin, double-charge mungkin, jobs/poller
  gagal diam-diam, stale screen yang bisa di-tap ke state lama.
- **Medium** — friksi UX, English bocor, error tidak ramah, race jarang.
- **Low** — kosmetik, inkonsistensi label, hardening.

---

## A. Wiring & Middleware Chain (`main.ts`, `middleware.ts`)
- **Urutan middleware**: verifikasi `bindUpdateId` → `sequentialize` → `session` →
  `conversations()` → `registeredUser` → `rateLimit` benar. Cek: apakah
  `registeredUser` jalan **sebelum** entry trigger sehingga `session.dbUser` &
  ban-check pasti ada? Apakah `rateLimit` melindungi callback **dan** message?
- **`sequentialize` key** (`main.ts:67`): `ctx.chat?.id ?? ctx.from?.id`. Cek update
  tanpa chat & tanpa from (mis. beberapa `my_chat_member`) — apakah key kosong
  `""` menggabung semua update tak berchat ke satu antrian (head-of-line blocking)?
- **`registeredUser` ban path** (`middleware.ts:39-45`): short-circuit untuk banned.
  Cek: balasan ban pakai `t()` (bukan English), dan **tidak** bocor ke conversation
  yang sedang aktif (apakah resume conversation bisa melewati ban? urutan: ban-check
  di group setelah `conversations()` → conversation yang sudah resume mungkin lolos).
- **`rateLimit`** (`middleware.ts:60-79`): in-memory `Map<number, number[]>` —
  (a) tidak persisten antar-restart (acceptable?); (b) **memory growth**: bucket
  tak pernah dihapus untuk user yang berhenti (lihat Phase 15-memory). Verifikasi
  apakah `buckets` punya housekeeping; jika tidak → Low/Medium leak.
  (c) Callback yang kena limit hanya `answerCallbackQuery` tanpa `show_alert` —
  cek konsistensi UX. (d) Window pakai `Date.now()/1000` float — boundary aman?
- **`drop_pending_updates`** (`main.ts:234`): pastikan stale "Buy/Approve" tap
  dibuang saat boot; best-effort try/catch — bila gagal, update lama diproses ke
  state lama. Catat sebagai risiko bila `deleteWebhook` gagal senyap.
- **Global send defaults** (`main.ts:54-63`): parse_mode HTML auto. Cek: caption
  produk/teks dari **input user** (nama produk, komentar review, alasan reject,
  username) yang dirender di HTML — apakah di-escape? `grep -rn "parse_mode\|<b>\|<code>\|escapeHtml\|escape" apps/order-bot/src` → cari interpolasi mentah ke HTML (risiko **HTML injection** via username/teks user).

## B. Conversation Engine (`conversations/*`)
- **Resume sebelum trigger** (`main.ts:73-84`): conversation aktif menelan update.
  Cek tiap conversation punya jalan keluar: **Cancel/Back hidup di tiap step** dan
  `/cancel` (`customer.cancelCommand`) benar-benar mengakhiri conversation aktif
  (bukan hanya reset session). Uji: user masuk checkout lalu kirim `/start` —
  apakah nyangkut di conversation atau keluar bersih?
- **Single-bubble wizard**: tiap step typed-input pakai `adminAnchor`/`menuAnchor`
  dan `consumeInput` (hapus pesan user). Verifikasi di `conversations/admin.ts` &
  `checkout.ts`: prompt, error validasi, dan konfirmasi final **mendarat di anchor
  yang sama**, bukan spam pesan baru. Cari `ctx.reply(` di dalam conversation yang
  seharusnya `adminEdit`/`adminAnchor` (gejala: bubble baru menumpuk).
- **Yang TIDAK boleh dihapus `consumeInput`**: free-text bernilai-record
  (teks support, komentar review, TxID) dan foto yang `file_id`-nya disimpan.
  Cek `conversations/support.ts` & checkout TxID — pastikan **tidak** ikut dihapus.
- **Timeout/abandon**: conversation yang ditinggal user (tak pernah selesai) —
  apakah ada timeout? `@grammyjs/conversations` menyimpan state di session;
  cek apakah session menumpuk state conversation yatim (lihat juga DB session store).
- **Validasi input** (`util/validators.ts`): qty, jumlah bayar, TxID — uji
  boundary: qty 0/negatif/sangat besar, desimal, spasi, emoji, string panjang.
- **Reject flow** (`conversations/reject.ts`): alasan reject = free-text user →
  dirender ke admin & user; cek escape HTML + `logAdminAction` terpanggil.

## C. Callback Router & Stale-Screen (`handlers/callbacks.ts`, `main.ts:99-113`)
- **Namespacing `v1:`**: semua callback data baru harus berprefiks `v1:`. Non-`v1:`
  → fallback `dead_tap` (`main.ts:102`) menjawab `error.stale_screen`. Verifikasi
  **tidak ada** tombol yang masih emit data non-`v1:` (akan selalu mati):
  `grep -rn "callback_data\|\.text(\|InlineKeyboard" apps/order-bot/src/keyboards` lalu cek prefiks.
- **`retireKeyboard`** (`chat.ts:42`): saat layar baru muncul di pesan lain,
  keyboard lama dipensiunkan. Uji "satu keyboard aktif per chat": buka Menu →
  buka Produk (bubble baru) → tap tombol di Menu lama → harus dapat stale toast,
  bukan aksi nyata. Cari render helper yang **lupa** memanggil retire.
- **Idempotensi tap**: tombol mutasi lambat render `admin.processing` dulu
  (anti double-tap). Cek di `handlers/admin.ts` & `checkout.ts`: approve/cancel/
  refund menampilkan buttonless processing sebelum commit. Uji double-tap cepat →
  tidak dobel commit.
- **Parsing id callback**: `v1:<action>:<id>` — id dari user. Cek **IDOR**: bisakah
  user mengirim callback dengan order id / ticket id milik orang lain? Router harus
  cek kepemilikan (`order.userId === ctx.from.id`) sebelum aksi. `grep -rn "Number(\|parseInt\|split(\":\")" apps/order-bot/src/handlers/callbacks.ts`.

## D. Render/UX Helper Compliance (`util/chat.ts`) — kontrak CLAUDE.md
- **Edit bubble, bukan toast**: tiap tombol terminal berakhir di `smartEdit`
  (customer) / `adminEdit` (admin) + keyboard navigasi. Cari aksi yang **hanya**
  `answerCallbackQuery` lalu meninggalkan layar lama (stranded). 
- **smartEdit/adminEdit fallback** (`chat.ts:71-188`): edit teks **dan**
  foto+caption; fallback fresh-send bila edit gagal (mis. pesan terlalu lama / sama).
  Cek penanganan error `message is not modified` & `message can't be edited`
  (>48 jam) — apakah ditelan rapi atau melempar ke `bot.catch`?
- **Never strand**: tiap layar terminal punya ≥1 aksi maju (Menu/Pesanan/Back).
  Telusuri semua titik akhir: order sukses, order ditolak, stok habis, error
  pembayaran, sesi habis, FAQ/terms — pastikan keyboard navigasi selalu ada.
- **Toast vs alert**: sukses rutin = toast (`answerCallbackQuery({text})`); error/
  destruktif = `show_alert:true`. `grep -rn "answerCallbackQuery" apps/order-bot/src`
  → cek konfirmasi destruktif (cancel order, hapus) pakai `show_alert`.

## E. i18n / No Leaked English (`util/i18n.ts`, locales)
- **Semua string customer & admin lewat `t()`/`coreT()`**. Cari literal user-facing:
  `grep -rnE "(reply|answerCallbackQuery|editMessageText|sendMessage)\([^)]*['\"][A-Za-z]" apps/order-bot/src` → setiap hardcoded English/Indonesia di luar `t()` = temuan.
- **Paritas kunci EN/ID**: bandingkan set kunci `packages/core/locales/en.json`
  vs `id.json` (harus identik) dan `{placeholders}` cocok per kunci. Skrip cepat:
  load kedua JSON, diff keys + diff regex `\{(\w+)\}` per nilai.
- **`setupCommandMenu`** (`main.ts:148-191`): deskripsi command EN/ID hardcoded —
  pastikan paritas EN vs `language_code:"id"`, dan menu admin hanya untuk `adminIds`.

## F. Admin Surface Security (`middleware.ts:adminOnly`, `handlers/admin.ts`)
- **Gate `adminOnly`** di **setiap** entry admin: command `/admin`, `/wallet`,
  semua callback admin, dan **conversation admin**. Cek `conversations/admin.ts`
  punya guard di entry (callback `adminOnly`) — bukan hanya command. Uji: non-admin
  kirim callback admin langsung → harus `error.admin_only` alert, bukan eksekusi.
- **`/wallet`** (`admin.adminWalletCommand`): penyesuaian saldo = uang. Cek Decimal,
  `logAdminAction`, dan tak ada nilai negatif liar / overflow. Audit trail wajib.
- **Approve/Reject pembayaran**: hanya admin; cek transisi state valid
  (tak bisa approve order yang sudah cancelled/paid) dan idempotensi.
- **Broadcast** (`jobs` + admin): segmen penerima dari user — cek tak ada cara
  broadcast ke target sembarang / spam, dan rate ke Telegram (429) ditangani.

## G. Payments Poller (`payments/binanceInternal.ts`, `bybitDeposit.ts`)
- **Auto-confirm matching**: cocokkan deposit ke order **by amount** (lihat
  `matchByAmount`). Uji ambiguitas: dua order jumlah sama → cek tidak salah
  mengonfirmasi order orang lain (Critical bila salah kredit).
- **Idempotensi**: webhook/poll ganda untuk satu TxID → order tak dikonfirmasi 2×,
  saldo tak dikredit 2×. Cek dedup berbasis TxID di crud.
- **Health & kegagalan senyap**: `getBinancePollHealth`/`getBybitPollHealth` dipakai
  job reconcile (`jobs/index.ts`). Cek: bila poller mati/exception, apakah ada
  alert ke admin atau hanya `logger.error` (blind spot)? Loop poller pakai
  try/catch yang menelan error tanpa backoff? Cek interval & 429 handling.
- **Secrets**: API key/secret Bybit/Binance — pastikan **tidak** di-log
  (`grep -rniE "logger.*(secret|apikey|api_key|token|signature)" apps/order-bot/src/payments`).
- **No-op tanpa creds** (`main.ts:248-250`): poller no-op bila creds kosong —
  verifikasi benar-benar diam (tak crash-loop, tak nge-poll endpoint kosong).
- **Money Decimal**: tak ada `parseFloat`/`Number()` untuk jumlah uang di matching.

## H. Jobs / Scheduler (`jobs/index.ts`, croner)
- **`autoCancelExpiredOrders`** (tiap menit): tiap order dibungkus
  `prisma.$transaction(cancelOrder)` — cek transaksi pendek (single-writer SQLite).
  Notifikasi user via `api.sendMessage` di-try/catch (gagal kirim ≠ batal cancel) ✓
  verifikasi. Cek: order yang gagal cancel di-retry menit berikut atau stuck?
- **Konkurensi job vs poller**: job auto-cancel bisa membatalkan order yang
  **sedang** dikonfirmasi poller (race expired vs paid). Cek penjagaan transisi
  state (cancel hanya bila masih PENDING di dalam transaksi).
- **Stale ticket close** (tiap jam) & **reconcile** (6 jam): cek idempotensi &
  audit (`logAdminAction` untuk aksi otomatis bila relevan).
- **`scheduleFxRefresh`** jalan sebelum token guard (`main.ts:203`) — verifikasi
  bot web-only boot tetap hidup (croner menahan proses) tanpa nge-spam API.
- **Single-instance**: bila bot di-scale 2 proses, croner jalan ganda → double
  cancel/broadcast. Catat asumsi single-instance (sesuai SQLite single-writer).

## I. Resilience / Failure Scenarios (asumsikan yang terburuk)
Telusuri perilaku saat:
- **Double-click / tap beruntun** tombol bayar/approve → `admin.processing` cegah?
- **User spam** command/callback → `rateLimit` + `sequentialize` cukup?
- **Server restart** di tengah checkout → conversation state di session pulih atau
  user nyangkut? `drop_pending_updates` buang tap lama.
- **Telegram API down / 429 / timeout** saat `sendMessage` notifikasi job/poller →
  ditangani per-item try/catch, tidak menggagalkan batch.
- **Edit gagal** (pesan >48 jam, identik, terhapus user) → fallback fresh-send,
  tak melempar ke `bot.catch`.
- **DB lambat / lock** (single-writer) → transaksi panjang memblok poller+job+
  handler. Cari `$transaction` panjang di handler bot.
- **`bot.catch`** (`main.ts:116-142`): selalu kasih `ref` ke user + log; pastikan
  **tidak** membocorkan stack/secret ke user, dan best-effort reply tak melempar lagi.

## J. State / Session Integrity (`context.ts`)
- **`session.dbUser` snapshot** (`middleware.ts:47-54`): cache role/saldo/lang.
  Cek **basi**: bila admin mengubah role/ban/saldo user via web saat sesi bot aktif,
  apakah bot pakai snapshot lama untuk otorisasi? (`adminOnly` pakai `isAdmin(id)`
  dari `ADMIN_IDS` runtime, bukan snapshot — verifikasi konsistensi sumber kebenaran).
- **Wallet balance di session** sebagai string — jangan dipakai untuk keputusan
  uang tanpa re-read DB di transaksi (risiko spend stale balance).
- **Session store**: di mana session disimpan (memory vs DB)? Bila memory →
  hilang saat restart (acceptable untuk UX, tapi conversation di tengah hilang).

---

## Langkah Investigasi (ringkas, jalankan berurutan)
1. `npx vitest run` lalu filter test bot: baca nama test untuk perilaku yang sudah
   dijamin (mis. "out-of-stock leaks no RESERVED", "matchByAmount").
2. Telusuri tiap section A–J di atas dengan grep `file:line` konkret; catat bukti.
3. Jalankan bot lokal (jika token tersedia) dan lakukan **end-to-end nyata**:
   - Customer: `/start` → Produk → Grup → Denominasi → Checkout → Bayar → Sukses.
   - Customer gagal: stok habis, batal bayar, voucher invalid, input qty salah.
   - Admin: `/admin` approve/reject, `/wallet`, broadcast — uji double-tap & non-admin.
4. Untuk tiap temuan, isi template output di bawah.

## Output → tulis ke `audit/reports/phase-16-bot-audit.md`
Tabel ringkas + detail per temuan:
```
ID | Severity | Area (A–J) | File:line | Gejala | Root cause | Dampak | Repro | Rekomendasi | Effort
```
Plus, bagian khusus:
- **Kepatuhan kontrak UX CLAUDE.md** — checklist lulus/gagal per aturan (edit-bubble,
  satu-keyboard, single-bubble wizard, never-strand, toast/alert, no-leaked-English).
- **Paritas i18n EN/ID** — daftar kunci hilang/placeholder tak cocok.
- **Risiko pembayaran & konkurensi** — daftar skenario double-credit/oversell + status.
- **Ringkasan**: jumlah per severity + 3 hal teratas yang wajib ditindak sebelum produksi.

## Constraint
**Jangan melakukan perubahan kode.** Fase analisis read-only. Laporan masuk ke
`audit/reports/phase-16-bot-audit.md` dan ikut diringkas oleh **Phase 15**
(production-readiness) bersama report fase lain.
