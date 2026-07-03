/**
 * Product photo upload — the one `/catalog/*` endpoint the React SPA still
 * calls directly (ProductDetailPage.tsx), because multipart uploads bypass
 * the JSON `/api` surface by design (mirrors branding.ts's own pattern).
 * Split out of the old routes/catalog.ts, whose other ~20 form-POST
 * endpoints were dead code superseded by routes/api/catalog.ts.
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { UPLOADS_DIR } from "../paths";
import { handleUpload } from "../lib/upload";
import { prisma, getCatalogProduct, updateCatalogProduct } from "@app/db";
import { currentAdmin } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const PRODUCT_PHOTO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PRODUCTS_DIR = join(UPLOADS_DIR, "products");
const PRODUCTS_URL_PREFIX = "/uploads/products";

export default async function catalogPhotoRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { productId: string } }>(
    "/catalog/product/:productId/photo",
    { preHandler: currentAdmin },
    async (req, reply) => {
      const productId = Number(req.params.productId);
      if (!Number.isInteger(productId) || productId <= 0) {
        return redirectWithFlash(reply, "/catalog", "Invalid product.", "error");
      }
      const product = await getCatalogProduct(prisma, productId);
      if (!product) {
        return redirectWithFlash(reply, "/catalog", "Product not found.", "error");
      }
      return handleUpload(req, reply, {
        kind: "product",
        field: "photo",
        allowed: PRODUCT_PHOTO_MIME,
        maxBytes: 5 * 1024 * 1024,
        destDir: PRODUCTS_DIR,
        urlPrefix: PRODUCTS_URL_PREFIX,
        getOldUrl: async () => product.webImageUrl,
        auditAction: "product_photo_upload",
        auditTarget: { type: "product", id: productId },
        redirectPath: `/catalog/${productId}`,
        details: (filename) => `Uploaded a new photo for product "${product.name}" (${filename}).`,
        afterSave: (url) => updateCatalogProduct(prisma, productId, { webImageUrl: url }),
      });
    },
  );
}
