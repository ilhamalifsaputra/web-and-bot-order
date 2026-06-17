# Upload UX: foto produk yang terlihat + upload QR Binance

**Tanggal:** 2026-06-17
**Status:** Disetujui (desain)

## Latar belakang

Keluhan awal "tidak bisa upload dari komputer" ternyata **bukan** bug backend upload
(diagnosis "Docker path mismatch" dari sesi sebelumnya menjawab pertanyaan yang berbeda).
Investigasi sistematis + konfirmasi gejala dari pengguna (Chrome asli, dev lokal,
"dialog file tak muncul di beberapa tempat, hanya di Brand settings") menunjukkan dua
hal yang **berperilaku sesuai desain lama**, bukan rusak:

1. **Foto produk** (`/catalog`) — kontrol upload SUDAH ADA (`catalog.njk:154-168`,
   "Upload photo from your device") tapi terkubur dua lapis: harus klik disclosure
   **"Edit"** lalu scroll ke bawah form. Terlihat seolah "tidak ada".
2. **QR Binance** (`/settings` → Payments) — **tidak ada** kontrol upload sama sekali.
   Setting `qr` adalah field teks berisi **Telegram file_id** (`settings.ts:39`),
   dirender macro `setting_form` sebagai `<input type="text">`.

Hanya halaman Branding (`/branding`) yang punya kontrol upload-dari-komputer yang
langsung terlihat — itulah sebabnya pengguna mengira "cuma Brand settings yang bisa".

## Tujuan

- Foto produk: jadikan tombol upload mudah ditemukan tanpa perlu masuk form "Edit".
- QR Binance: tambah kontrol upload-dari-komputer di kartu USDT/Binance pada
  Settings → Payments, mempertahankan field teks file_id untuk jalur lama.

## Non-tujuan

- Tidak menyentuh `docker-compose.yml` (kode upload sudah benar via `paths.ts`).
- Tidak mengubah skema Prisma — `qr_fileid` cukup sebuah row `settings` baru,
  persis seperti `banner_image_fileid`.
- Tidak menyentuh fitur Binance Internal Transfer (di-keep sampai upload beres).

## Bagian A — Foto produk mudah ditemukan (frontend saja)

**File:** `apps/web-admin/views/catalog.njk`

Pindahkan blok "Upload photo from your device" (baris 154-168) keluar dari
`<details>` "Edit" (baris 134) menjadi **disclosure sendiri berlabel "Foto"**,
sejajar "Edit" dan "Quantity discount" di baris aksi tiap produk (baris 133-134).

- Summary "Foto" memberi penanda apakah produk sudah punya foto (mis. teks
  "Foto ✓" bila `p.webImageUrl` ada, atau "Foto" bila belum).
- Isi disclosure: preview foto saat ini (bila ada) + form upload yang TIDAK berubah.

**Tidak ada perubahan backend.** Route `POST /catalog/product/:id/photo`
(`catalog.ts`) tetap apa adanya. Field "Web photo URL" di dalam form Edit
(baris 145-149) tetap di tempatnya — disclosure "Foto" hanya jalur upload-dari-device.

## Bagian B — Upload QR Binance (full-stack, meniru pola banner)

Pola acuan: `banner_image` sudah dual-mode (path upload `/uploads/…` ATAU file_id),
dengan cache file_id (`banner_image_fileid`) supaya bot re-upload maksimal sekali.
Lihat `apps/order-bot/src/util/banner.ts` dan `branding.ts` (banner upload).

### B1. Route web baru — `POST /settings/qr`

**File:** `apps/web-admin/src/routes/settings.ts`

- preHandler manual (bukan `csrfProtect` form-body, karena multipart) — ikuti pola
  `branding.ts handleUpload`: parse `req.parts({ limits: { fileSize } })`, cek
  `csrf_token` field == `req.admin!.csrf`, gate `canMutate(req.admin!.role, req.url)`.
- MIME raster yang diizinkan: `image/jpeg→jpg`, `image/png→png`, `image/webp→webp`
  (sama dengan `RASTER_MIME` di branding). Maks 5 MB.
- Tulis ke `join(UPLOADS_DIR, "qr")/qr-<randomBytes(8)>.<ext>` memakai `UPLOADS_DIR`
  dari `apps/web-admin/src/paths.ts` (`mkdir … { recursive: true }`).
- `setSetting(prisma, "qr", "/uploads/qr/<filename>")`.
- Hapus upload QR lama (bila nilai `qr` sebelumnya diawali `/uploads/qr/`) +
  `deleteSetting(prisma, "qr_fileid")` (invalidasi cache).
- `logAdminAction` action `settings_qr_upload`, targetType `setting`,
  details `filename=…` (jangan log isi file).
- Redirect `/settings` dengan flash "Saved." / pesan error yang sesuai.

**Reuse:** helper `handleUpload` di `branding.ts` saat ini module-private dan
hardcoded redirect ke `/branding`. Jika ekstraksi ke util bersama
(`apps/web-admin/src/lib/upload.ts`) bisa rapi tanpa over-engineering, lakukan;
jika tidak, replikasi versi ringkas khusus QR di `settings.ts`. Keputusan final
diambil saat implementasi — keduanya dapat diterima.

### B2. Whitelist & cache key

**File:** `apps/web-admin/src/routes/settings.ts`

- `qr` tetap di `EDITABLE` (field teks file_id tetap bisa diedit manual). Perbarui
  label `qr` agar menyebut kedua jalur, mis. `"Payment QR — upload below, or paste a Telegram file_id"`.
- `qr_fileid` adalah cache internal (bukan field UI yang diedit teks). Tidak perlu
  masuk `EDITABLE`. Sembunyikan dari tabel "All saved data" bila perlu (opsional —
  konsisten dengan apakah `banner_image_fileid` saat ini disembunyikan; samakan).

### B3. UI — kartu USDT/Binance

**File:** `apps/web-admin/views/settings.njk` (kartu "USDT via Binance", baris 104-115)

- Tambah form upload multipart di atas/bawah field-field `pay_binance_fields`:
  `enctype="multipart/form-data"`, action `/settings/qr`, `csrf_token` hidden,
  `<input type="file" name="qr_image" accept="image/jpeg,image/png,image/webp" required>`,
  tombol "Upload QR".
- Preview QR saat ini bila nilai `qr` diawali `/uploads/` (tampilkan `<img>`).
  Sediakan flag dari route GET `/settings` (mis. `qr_is_upload` + `qr_url`).
- Field teks file_id (`setting_form` untuk `qr`) tetap dirender via
  `pay_binance_fields` seperti sekarang.

### B4. Util bot — resolusi QR

**File baru:** `apps/order-bot/src/util/qr.ts` (kembar `banner.ts`)

```
QR_KEY = "qr"
QR_FILEID_KEY = "qr_fileid"
UPLOADS_ROOT = process.env.UPLOADS_DIR ?? join(HERE, "..","..","..","..","data","uploads")

resolveQrValue(qr, cachedFileId): { kind: "none" } | { kind: "fileId", fileId }
                                  | { kind: "upload", relPath }
qrPhotoArg(qr, cachedFileId): { photo: string | InputFile, needsCache: boolean } | undefined
```

Aturan identik banner: nilai diawali `/uploads/` → upload (pakai cache file_id
bila ada, else `InputFile`); selain itu → file_id; kosong → none.

### B5. Checkout memakai util + cache

**File:** `apps/order-bot/src/handlers/checkout.ts` (baris 227-250, 257-279)

- Ganti resolusi manual `qrFileId` (baris 244-250) dengan
  `qrPhotoArg(await getSetting(prisma,"qr"), await getSetting(prisma,"qr_fileid"))`.
- Pertahankan fallback terakhir `config.BINANCE_QR_PATH` (baris 248) untuk kasus
  `kind: "none"` — yaitu jika `qrPhotoArg` undefined dan file bundel ada,
  kirim `new InputFile(config.BINANCE_QR_PATH)`.
- Setelah `replyWithPhoto` sukses (baris 261-267): bila yang dikirim adalah upload
  (`needsCache`), simpan `qrMsg.photo.at(-1)!.file_id` ke `qr_fileid` via
  `setSetting` (best-effort, dibungkus try/catch agar gagal-cache tak menggagalkan
  checkout). Ini membuat upload-ulang maksimal sekali per QR, persis banner.

### B6. Jalur lama tetap hidup

Bot men-set QR via foto → file_id (`conversations/admin.ts:433`) tetap valid:
cabang `kind: "fileId"` tak berubah. Mengirim foto QR baru dari bot menimpa `qr`
dengan file_id (bukan `/uploads/`), sehingga cache `qr_fileid` tak relevan untuk
jalur itu. (Catatan: web upload membersihkan `qr_fileid`; bot-set file_id tidak
perlu karena nilainya sendiri sudah file_id.)

## Pengujian

- **Unit** `apps/order-bot/test/…`: `resolveQrValue` — kembar tes `resolveBannerValue`
  (none / fileId / upload-tanpa-cache / upload-dengan-cache).
- **Web** `apps/web-admin/test/web.test.ts`: trio untuk `POST /settings/qr` —
  happy (302 + setting tersimpan `/uploads/qr/…`), auth-fail (tanpa sesi → tolak),
  bad-csrf (csrf salah → 403). Ikuti pola tes upload branding yang sudah ada.
- `pnpm -r typecheck` dan `pnpm test` harus hijau.

## Risiko & catatan

- **Jalur uang:** QR muncul di layar pembayaran. Perubahan checkout harus menjaga
  fallback (file bundel) dan tidak boleh menggagalkan checkout bila cache gagal.
- **Jangan log rahasia:** audit upload QR hanya mencatat filename, bukan isi.
- **Single-writer SQLite:** `setSetting` cache file_id adalah tulisan singkat; aman.
- Konsistensi `UPLOADS_DIR`/`UPLOADS_ROOT` dev vs Docker sudah ditangani oleh
  `paths.ts` (web) dan resolusi modul-relatif (bot) — QR mewarisi itu.
