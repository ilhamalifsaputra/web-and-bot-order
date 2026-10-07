-- The buyer-facing phase a Telegram progress message last rendered, and when
-- it entered that phase, so a payment stuck in "detected" stops spinning.
ALTER TABLE "fulfillment_messages" ADD COLUMN "phase" TEXT,
  ADD COLUMN "phase_started_at" TIMESTAMP(3);
