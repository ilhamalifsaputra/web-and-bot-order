-- Backend audit E2 item 1: an Idempotency-Key is now reserved BEFORE its
-- mutation runs, so two concurrent requests with the same key can no longer
-- both run it. A reserved-but-unfinished row carries `pending_since`; a saved
-- response clears it. Nullable with no default, so every existing row (all of
-- them completed responses) reads as completed.
ALTER TABLE "idempotency_records" ADD COLUMN "pending_since" TIMESTAMP(3);
