-- Add optional image support to broadcasts: a disk-served upload path
-- (web_image_url) plus a cached Telegram file_id (image_file_id), following
-- the same webImageUrl/imageFileId pair used by products/denominations.

ALTER TABLE "broadcasts" ADD COLUMN "web_image_url" TEXT;
ALTER TABLE "broadcasts" ADD COLUMN "image_file_id" TEXT;
