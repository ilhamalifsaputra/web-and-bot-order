-- AlterTable
ALTER TABLE "denominations" ADD COLUMN     "detection_sku_key" TEXT,
ADD COLUMN     "detection_stamp" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "detection_base_product_key" TEXT,
ADD COLUMN     "detection_confidence" DECIMAL(65,30),
ADD COLUMN     "detection_product_key" TEXT,
ADD COLUMN     "detection_stamp" TEXT,
ADD COLUMN     "detection_status" TEXT;

-- CreateTable
CREATE TABLE "detection_tokens" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "is_product_defining" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "detection_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_aliases" (
    "id" SERIAL NOT NULL,
    "alias" TEXT NOT NULL,
    "expands_to" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "detection_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_overrides" (
    "id" SERIAL NOT NULL,
    "match_kind" TEXT NOT NULL,
    "match_value" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "base_product_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hit_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "detection_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_issues" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL,
    "review_status" TEXT NOT NULL DEFAULT 'OPEN',
    "input_fingerprint" TEXT NOT NULL,
    "raw_input" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "candidates" TEXT,
    "detector_stamp" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detection_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_detection_tokens_category_token" ON "detection_tokens"("category", "token");

-- CreateIndex
CREATE UNIQUE INDEX "ix_detection_aliases_alias" ON "detection_aliases"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "ix_detection_overrides_match" ON "detection_overrides"("match_kind", "match_value");

-- CreateIndex
CREATE UNIQUE INDEX "ix_detection_issues_fingerprint" ON "detection_issues"("input_fingerprint");

-- CreateIndex
CREATE INDEX "ix_detection_issues_status_seen" ON "detection_issues"("review_status", "last_seen_at");

-- CreateIndex
CREATE INDEX "ix_denominations_detection_sku_key" ON "denominations"("detection_sku_key");

-- CreateIndex
CREATE INDEX "ix_products_detection_product_key" ON "products"("detection_product_key");
