# Canonical products: web dan Telegram

Otoritas: prompt pengguna `prompt-codex-canonical-product-web-telegram.md` (30 September 2026). Pengguna meminta analisis lalu implementasi tanpa approval tambahan kecuali keputusan bisnis yang belum diketahui.

## Temuan repository

- Category → Product → Denomination; Denomination.id adalah identity checkout. `prisma/schema.prisma`, `packages/db/src/crud/catalog.ts`.
- Digiflazz import/resync: `packages/db/src/crud/digiflazz.ts`. Import menyimpan `stripRegionSuffix(row.productName)` sebagai name/durationLabel, sehingga nama supplier exact belum tersimpan. Tambahkan kolom nullable supplierRawName, isi import dan resync; baris lama fallback name dengan provenance eksplisit sampai sync berikutnya. Jangan mengarang nama supplier lama.
- Harga tersimpan IDR Decimal sampai 4 digit pecahan; `effectiveUnitPrice` pada `packages/core/src/flash.ts` memilih reseller/flash lalu menerapkan kebijakan existing `wholeRupiah` HALF_UP. Adapter mendukung presisi caller sampai4, tetapi snapshot katalog aktif mengikuti harga efektif checkout (rupiah bulat). Checkout membaca harga terbaru. Jangan mengubah markup, arithmetic, snapshot order atau fulfillment.
- DisplayCurrency IDR/USD tersedia; konversi existing `usdtFromIdr` menggunakan rate IDR per USDT dan ceil 2dp. USD adalah label display kebijakan existing, settlement USDT tetap asset berbeda.
- SPA aktif: `apps/storefront/src/routes/apiPages.ts` → `pageData.ts` → React `ProductPage.tsx`/`InstantBuyPage.tsx` → `components/shop/DenominationCard.tsx`. API katalog legacy masih tersedia di `routes/api.ts`.
- Bot aktif: `handlers/customer.ts`, `keyboards/customer.ts`, `util/denominationLabel.ts`; keyboard dua kolom melakukan truncation 24 karakter, dan structured qty dapat menghilangkan qualifier/bonus.
- Fixture katalog nyata tersedia di `packages/core/src/detection/__fixtures__/catalogSnapshot.json`. Harga contoh harus synthetic. Tidak ada screenshot masalah terkini yang diberikan.
- Frontend boundaries melarang import @app/core; mirror DTO di client, parsing/conversion canonical hanya backend.

## Desain

Adapter pure di `packages/core/src/canonicalProduct.ts` menerima scalar data Denomination, Product dan Category, harga effective dari caller serta currency/rate context. Output canonical platform-neutral dengan variant discriminated union, rawName/provenance, category/product qualifier, displayName, exact Money, availability dan generatedAt. Zod memvalidasi runtime. ID internal number; supplierSku nullable, tidak dianggap unik global. Money IDR scale 0..4 (digit integer string), USD scale 2, sehingga tidak ada kehilangan pecahan rupiah. Rate metadata menyatakan basis USDT dan arah IDR per USDT; waktu yang tidak ada tidak boleh dibuat seolah timestamp sumber.

Parsing konservatif: utamakan qtyValue/qtyUnit tetapi selalu pertahankan token lain dari name/durationLabel; hanya alias game terverifikasi pada prefix/token aman, bukan arbitrary replace. Dot grouping hanya Digiflazz yang terbukti dari fixture; comma ambiguity fallback unknown kecuali explicit rule. Named packages tidak diubah menjadi angka. Unit semantic lengkap, qualifier tidak ditimpa, conflicting/unrecognized text tetap terlihat.

API additive `canonical` pada denominations, serta adapter list/detail sesuai rute existing. Data internal cost/credentials tidak boleh keluar. React memakai displayName lengkap, qualifier dan server exact formatted price (tanpa browser menghitung rate canonical). Fallback DTO lama tetap aman. Tidak ada redesign.

Telegram presenter menerima canonical, locale dan backend price. Quantity compact hanya lossless; label collision memakai qualifier nyata lalu ID stabil. Layout berdasarkan final label dan grapheme visual width: satu/dua tombol sesuai heuristic; unknown satu kolom. Label sangat panjang memakai tombol identifier pendek terkait daftar nama dan harga exact pada pesan, dengan pagination jika diperlukan untuk batas caption/message. Callback `v1:browse:denom:<id>` dipertahankan, UTF-8 <=64 bytes. Detail/konfirmasi memakai nama lengkap dan harga exact. Click stale mengambil DB terbaru, existing confirmation sebelum purchase.

## Verifikasi dan batas

TDD Vitest untuk semantic preservation, exact money, API runtime, React, keyboard/callback/layout dan checkout stale. Jalankan typecheck, lint, build, boundary dan relevant tests. PostgreSQL lokal/Docker belum tersedia pada analisis awal; jangan menyentuh produksi. Migrasi additive disertakan, tidak diaplikasikan ke produksi. Manual Telegram Android/iOS/Desktop dan visual web belum terverifikasi.
