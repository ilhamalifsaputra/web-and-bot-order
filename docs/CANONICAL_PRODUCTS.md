# Produk canonical pada web dan Telegram

Implementasi 30 September 2026. Tidak ada perubahan margin, ID/SKU, stock reservation, fulfillment, settlement, atau snapshot histori order.

## Source of truth dan jalur aktif

Katalog tetap Category → Product → Denomination di `prisma/schema.prisma` dan `packages/db/src/crud/catalog.ts`. Denomination.id adalah identitas SKU checkout. Task1 menyimpan nama supplier exact pada nullable `supplierRawName`; Digiflazz import/resync mengisinya. Baris lama memakai `name` dengan provenance `legacy_name` sampai resync, tanpa mengarang nama supplier lama.

Harga tampilan berasal dari `effectiveUnitPrice` di `packages/core/src/flash.ts`, sama dengan checkout: reseller/flash dipilih melalui aturan existing. Helper ini sudah menerapkan HALF_UP ke whole rupiah pada harga tersimpan. Jadi harga DB synthetic `21000.1254` menjadi harga effective `21000`, bukan perubahan rounding oleh canonical. Adapter pure tetap mampu mempertahankan input IDR sampai empat digit pecahan (`130833.1254` → amountMinor `1308331254`, scale4).

`canonicalProduct` di `packages/core/src/canonicalProduct.ts` memvalidasi output dengan Zod. Backend SPA `apps/storefront/src/pageData.ts` + `routes/apiPages.ts` serta katalog kompatibilitas `routes/api.ts` menambahkan `canonical` pada denominations. Cart `routes/cart.ts` dan checkout preview `routes/checkout.ts` juga menambahkan snapshot canonical untuk informasi SKU sebelum pembayaran. Biaya supplier, credentials dan metadata internal tidak disalin ke DTO.

React memakai mirror DTO `apps/storefront/client/src/api/canonical.ts`. DenominationCard, ProductPage, InstantBuyPage, CartPage dan CheckoutPage memakai nama lengkap/qualifier/harga unit exact dari backend. Payload lama tetap memiliki fallback existing. Tidak ada parsing nama supplier atau perhitungan rate canonical di browser. Totals, biaya gateway dan histori order tetap jalur existing.

Bot `handlers/customer.ts` dan confirmation `handlers/checkout.ts` memakai adapter yang sama. `util/canonicalPresenter.ts` mengatur label, grapheme width, collision, baris dan pagination; harga transaksi tidak memakai compact label. Klik katalog mengambil DB terbaru dan tetap melalui konfirmasi existing; tidak menciptakan order hanya karena klik katalog.

## Kontrak TypeScript aktual

Ini kontrak output domain; `CanonicalProductSchema` adalah validator runtime yang diekspor bersama adapter.

```ts
type CanonicalMoney =
  | { currency: "IDR"; amountMinor: string; scale: number } // integer 0..4
  | { currency: "USD"; amountMinor: string; scale: 2 };
// amountMinor: string integer non-negatif, tanpa exponent/sign/decimal.
type CanonicalVariant =
  | { type: "amount"; quantity: number; unit: string; residual: string[];
      bonus?: { quantity: number; unit: string; label?: string } }
  | { type: "subscription" | "pass"; name: string; residual: string[];
      duration?: { value: number; unit: "day" | "week" | "month" | "year" } }
  | { type: "package" | "bundle" | "voucher" | "unknown";
      name: string; residual: string[] };
interface CanonicalProduct {
  id: number; // positive safe integer; internal Denomination.id
  supplierSku: string | null;
  rawName: string;
  rawNameProvenance: "supplier" | "legacy_name";
  displayName: string; // derives from variant plus residual
  variant: CanonicalVariant;
  qualifiers: string[]; // product.gameRegion + gameVariant, both preserved
  product: { id: number; name: string; gameVariant: string | null; gameRegion: string | null };
  category: { id: number; name: string; group: string | null };
  priceIDR: CanonicalMoney; // always IDR
  displayPrice: CanonicalMoney;
  formattedPrice: string; // backend exact localized text
  currencyFallback: boolean;
  conversion: {
    basis: "USDT"; direction: "IDR_PER_USDT"; rate: string;
    rounding: "CEIL_2DP";
    source: "settings:usd_idr_rate" | "config:USDT_IDR_RATE" | "caller";
    asOf: string | null; // ISO confirmation timestamp, never generatedAt
  } | null;
  availability: { status: "available" | "inactive" | "out_of_stock"; purchasable: boolean };
  createdAt: string | null;
  generatedAt: string;
}
interface CanonicalProductContext {
  effectivePriceIDR: string;
  preferredCurrency: "IDR" | "USD";
  rate?: string | null;
  rateSource?: "settings:usd_idr_rate" | "config:USDT_IDR_RATE" | "caller";
  rateAsOf?: string | null;
  locale?: string;
  generatedAt?: string;
}
interface CanonicalProductInput {
  denomination: {
    id: number; name: string; durationLabel: string; supplierRawName?: string | null;
    supplierSku?: string | null; autoDeliverySource?: string | null;
    qtyValue?: number | null; qtyUnit?: string | null; isActive: boolean; createdAt?: string | null;
  };
  product: {
    id: number; name: string; digiflazzBrand?: string | null;
    gameVariant?: string | null; gameRegion?: string | null;
    isActive: boolean; isArchived?: boolean;
  };
  category: { id: number; name: string; group?: string | null; isActive: boolean };
  stockAvailable?: boolean;
}
function canonicalProduct(input: CanonicalProductInput, context: CanonicalProductContext): CanonicalProduct;
```

quantity/duration/bonus harus positive safe integer. Status harus konsisten dengan purchasable; displayName harus berasal dari variant. USD display harus mempunyai conversion. Residual mempertahankan token yang belum dikenali atau berbeda dari field editable. Qualifier produk tidak menimpa token variant; semua tetap tampil, termasuk konflik.

Existing USD display tetap kebijakan konversi IDR per USDT, bukan klaim settlement USD. `getCanonicalRateContext` di DB membaca existing `getUsdIdrRate` (termasuk aturan staleness), source setting/config dan timestamp sekali per screen/request. `asOf` berasal dari `usd_idr_rate_updated_at` hanya bila sumbernya saved setting dan timestamp valid; jika sumber config, timestamp tidak diketahui dan bernilai null. Pure caller tanpa provenance memakai `caller`. Rate invalid/missing mengikuti fallback IDR dan notice existing.

## Contoh JSON list dan detail

Semua ID, SKU, waktu dan harga berikut synthetic, memakai fixture API manual-delivery. Header `Cookie: shop_lang=id; shop_currency=IDR`. Field legacy dipertahankan; `price` legacy pada endpoint kompatibilitas adalah nilai DB, sedangkan canonical menunjukkan effective price yang akan dipakai checkout. `stock/status` legacy tetap count inventory; canonical availability mengerti manual delivery sehingga stock0 tidak berarti tidak bisa dibeli.

`GET /api/v1/products`:

```json
{
  "products": [{
    "id": 1, "slug": "mobile-legends", "name": "Mobile Legends", "description": null, "image": null,
    "category": { "id": 1, "slug": "canonical-fixture", "name": "Canonical", "emoji": null, "description": null, "image": null },
    "denominations": [{
      "id": 17, "name": "86 Diamonds + 8 Bonus Global", "price": "21000.1254", "stock": 0, "status": "out_of_stock",
      "canonical": {
        "id": 17, "supplierSku": "synthetic-86", "rawName": "Mobile Legends 86 Diamonds + 8 Bonus Global", "rawNameProvenance": "supplier",
        "displayName": "86 Diamonds + 8 Bonus Global",
        "variant": { "type": "amount", "quantity": 86, "unit": "Diamonds", "residual": ["Global"], "bonus": { "quantity": 8, "unit": "Diamonds", "label": "Bonus" } },
        "qualifiers": ["Indonesia"],
        "product": { "id": 1, "name": "Mobile Legends", "gameVariant": null, "gameRegion": "Indonesia" },
        "category": { "id": 1, "name": "Canonical", "group": null },
        "priceIDR": { "currency": "IDR", "amountMinor": "21000", "scale": 0 },
        "displayPrice": { "currency": "IDR", "amountMinor": "21000", "scale": 0 },
        "formattedPrice": "Rp21.000", "currencyFallback": false, "conversion": null,
        "availability": { "status": "available", "purchasable": true },
        "createdAt": "2026-09-30T00:00:00.000Z", "generatedAt": "2026-09-30T01:00:00.000Z"
      }
    }]
  }]
}
```

`GET /api/v1/products/mobile-legends` (same additive denomination contract):

```json
{
  "product": {
    "id": 1, "slug": "mobile-legends", "name": "Mobile Legends", "description": null, "image": null,
    "category": { "id": 1, "slug": "canonical-fixture", "name": "Canonical", "emoji": null, "description": null, "image": null },
    "denominations": [{
      "id": 17, "name": "86 Diamonds + 8 Bonus Global", "price": "21000.1254", "stock": 0, "status": "out_of_stock",
      "canonical": {
        "id": 17, "supplierSku": "synthetic-86", "rawName": "Mobile Legends 86 Diamonds + 8 Bonus Global", "rawNameProvenance": "supplier",
        "displayName": "86 Diamonds + 8 Bonus Global",
        "variant": { "type": "amount", "quantity": 86, "unit": "Diamonds", "residual": ["Global"], "bonus": { "quantity": 8, "unit": "Diamonds", "label": "Bonus" } },
        "qualifiers": ["Indonesia"],
        "product": { "id": 1, "name": "Mobile Legends", "gameVariant": null, "gameRegion": "Indonesia" },
        "category": { "id": 1, "name": "Canonical", "group": null },
        "priceIDR": { "currency": "IDR", "amountMinor": "21000", "scale": 0 },
        "displayPrice": { "currency": "IDR", "amountMinor": "21000", "scale": 0 },
        "formattedPrice": "Rp21.000", "currencyFallback": false, "conversion": null,
        "availability": { "status": "available", "purchasable": true },
        "createdAt": "2026-09-30T00:00:00.000Z", "generatedAt": "2026-09-30T01:00:00.000Z"
      }
    }]
  }
}
```

SPA active `GET /api/v1/pages/product/mobile-legends` memakai outer `{product, denominations, default_restock_denomination_id, related_products, reviews, low_threshold}`. Setiap denomination mempertahankan `name`, `duration_label`, effective `price`, `flash`, `warranty_days`, `available`, `in_stock`, `bulk`, `delivery_type`, `additional_fields`, dan menambahkan canonical yang sama. `/products/:slug/denominations` memakai `{denominations}`. Tidak ada endpoint/schema pagination baru pada HTTP.

Jika preference USD, locale en, saved rate16000 dikonfirmasi pada synthetic `2026-09-30T00:30:00.000Z`, fields harga pada canonical tersebut menjadi:

```json
{
  "priceIDR": { "currency": "IDR", "amountMinor": "21000", "scale": 0 },
  "displayPrice": { "currency": "USD", "amountMinor": "132", "scale": 2 },
  "formattedPrice": "$1.32", "currencyFallback": false,
  "conversion": { "basis": "USDT", "direction": "IDR_PER_USDT", "rate": "16000", "rounding": "CEIL_2DP", "source": "settings:usd_idr_rate", "asOf": "2026-09-30T00:30:00.000Z" }
}
```

## Sebelum / sesudah

Nama amount/package bertanda nyata berasal dari `packages/core/src/detection/__fixtures__/catalogSnapshot.json`; semua harga adalah synthetic. Bonus/long/unknown/collision khusus pengujian synthetic. Label contoh locale en, tanpa qualifier produk tambahan kecuali disebutkan.

| Kasus | Sebelum | Telegram baru | Web baru |
| --- | --- | --- | --- |
| Amount nyata | `Mobile Legends 1.050 Diamonds` berisiko dipotong24char | `1.05K Diamonds · Rp21K` | `1050 Diamonds`, exact `Rp21,000` |
| Bonus synthetic | structured qty saja bisa membuang bonus | `86 Diamonds + 8 Bonus · Rp21K` dalam satu kolom | `86 Diamonds + 8 Bonus Global`, qualifier Indonesia terpisah |
| Paket nyata | `Growtopia Its Rainin Gems` dipotong/gagal qty fallback | `Its Rainin Gems · Rp131K` | `Its Rainin Gems`, exact `Rp130,833` |
| Long synthetic | `1680 Coins + B… — Rp300K` | `1.68K Coins + Bonus · Rp300K`, satu kolom | `1680 Coins + Bonus`, exact `Rp300,000` |
| Unknown sangat panjang | meaningful final qualifier hilang | tombol `#17`, daftar nama penuh + exact price; lanjut halaman bila perlu | semua teks wrapping; rawName tetap di DTO |
| Collision synthetic | dua `86 Diamonds` harga20001/20002 sama-sama Rp20K | suffix `#17`/`#18`, atau identifier fallback jika panjang | exact `Rp20,001`/`Rp20,002`, ID tetap17/18 |

Quantity compact tidak membulatkan: 9375 → `9.375K` (locale id: `9,375K`), 10001 → `10.001K`; bonus dan residual tetap terlihat. Harga compact mengikuti helper existing: IDR>=1000 dan<1juta nearest wholeK,>=1juta dua decimalM HALF_UP. Suffix bukan harga transaksi. USD tombol memakai exact localized USD backend.

Semua qualifier ditampilkan; tidak memakai substring arbitrer untuk menganggap qualifier redundant. Label yang identik diberi ID stabil sebelum layout. Fallback identifier-only tidak bisa disamakan dengan unknown raw name `#17` + harga. Final visual width<=24 dan known variant boleh dua tombol per row; unknown/lebih lebar satu row;>44 memakai #ID terkait pesan lengkap. Unit semantic (`Diamonds`, `World Lock`, `UC`) tetap literal, tidak emoji saja.

Isi daftar di-escape HTML per grapheme, maksimal3000 karakter serialized per page dan20 tombol SKU per page, menyisakan budget notice/footer sebelum4096. Nama tunggal sangat panjang dibagi lossless ke beberapa halaman, setiap fragmen tetap membawa #ID/harga exact dan callback SKU yang sama. Photo caption>1024 menggunakan fallback text existing. Detail/konfirmasi dengan nama>1200 serialized mengirim fragmen lengkap dahulu, lalu summary interaktif #ID. Callback tetap `v1:browse:denom:<denominationId>` dan diperiksa UTF-8<=64 bytes; navigasi kompatibel `v1:browse:pick:<productId>[:page]`.

## Cache, rollout dan verifikasi

Personalized context/catalog/cart/checkout memakai `Cache-Control: private, no-store`. React query key memuat currency,locale dan private `pricing_context` (viewer ID/role atau guest). Currency switch invalidates context/product/cart/checkout; preference refetch memperbarui text item checkout tanpa membuang input. Existing login/register/logout/language berpindah lewat full reload. Harga DB/quote tetap divalidasi ulang saat checkout.

Deploy terpisah dari task ini: jalankan migration additive Task1 `20260930000000_add_denomination_supplier_raw_name` sebelum binary baru, generate Prisma dan restart bot sesuai prosedur deployment repo. Resync Digiflazz mengisi raw name exact; baris lama tetap aman melalui provenance fallback. Tidak ada migration produksi/deployment dijalankan oleh task.

Focused verification yang benar-benar dilakukan: core53 + presenter9 GREEN; React card15 GREEN; catalog API7 (runtime contract, missing-rate/source/asOf/parity, signed reseller vs guest) dan InstantBuy23 GREEN; bot current-price/status/huge-name serta affected catalog55 GREEN; Product46, Cart18, Checkout60 dan currency refetch1 GREEN. Tiga file tes kompatibilitas SPA/Top Up/bot: 205/205 GREEN; perbandingan preview tetap mencakup seluruh respons dan item, hanya `canonical.generatedAt` yang dikecualikan karena dibuat per request. Test TypeScript GREEN. Controller memverifikasi recursive9 package types, test TypeScript, lint, dua SPA builds dan frontend boundary: exit0. Chromium3/3 GREEN: nama panjang/bonus/qualifier dan exact effective price viewport1280/375 tanpa overflow; wallet checkout paid+delivered; stock berubah mid-checkout memberi retry eksplisit. Suite penuh final ditangani controller, bukan diklaim selesai oleh laporan ini.

Screenshot pengguna tidak tersedia. Chromium3/3 dijalankan controller pada isolated PostgreSQL, tanpa gateway nyata. Telegram Android/iOS/Desktop, font scale besar dan perangkat nyata belum diverifikasi. Heuristic width tidak menjamin pixel-perfect pada semua client. Manual checklist: cek single/mixed rows, unknown#ID/detail, bonus+region, USD fallback notice, navigasi halaman panjang, serta latest price sebelum konfirmasi di ketiga client Telegram.
