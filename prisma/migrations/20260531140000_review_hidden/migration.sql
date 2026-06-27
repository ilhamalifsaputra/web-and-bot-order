-- Reviews moderation: a `hidden` flag so the operator can suppress abusive
-- reviews. The order bot excludes hidden rows from the per-product rating
-- average it shows customers. Apply in dev with `pnpm prisma db push`; this
-- file is the reproducible delta for production cutover.

ALTER TABLE "reviews" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
