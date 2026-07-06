/**
 * Per-product photo resolution — the admin-uploaded `Product.webImageUrl` (or
 * cached `Product.imageFileId`) rendered as the product's own chat bubble,
 * independent of the global site banner. Delegates the actual upload-path vs.
 * file_id vs. none resolution to `bannerPhotoArg` (util/banner.ts), which is
 * already generic over any two (url, cachedFileId) strings.
 */
import type { InputFile } from "grammy";
import { prisma, updateCatalogProduct } from "@app/db";
import { bannerPhotoArg } from "./banner";

export function productPhotoArg(
  product: { webImageUrl: string | null; imageFileId: string | null },
): { photo: string | InputFile; needsCache: boolean } | undefined {
  return bannerPhotoArg(product.webImageUrl, product.imageFileId);
}

/** Cache the resolved file_id onto the product row after its first photo send. */
export function cacheProductPhotoFileId(productId: number) {
  return async (fileId: string): Promise<void> => {
    await updateCatalogProduct(prisma, productId, { imageFileId: fileId });
  };
}
