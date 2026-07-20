-- Web-uploaded ticket evidence (image/video), stored as comma-joined
-- /uploads/tickets/... URLs. Kept separate from photo_file_ids, which is
-- Telegram file_ids from the bot's support flow and unusable as a web <img src>.

ALTER TABLE "support_tickets" ADD COLUMN "attachment_urls" TEXT;
ALTER TABLE "ticket_messages" ADD COLUMN "attachment_urls" TEXT;
