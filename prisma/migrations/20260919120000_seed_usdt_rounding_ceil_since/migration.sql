-- Data-only migration. No schema change: it seeds one `settings` row.
--
-- `usdt_rounding_ceil_since` is the end date of `reconcileFinances`' exemption
-- for USDT totals rounded the pre-M13 way (0.1 half-up instead of 0.01 ceil).
-- The exemption previously had no end date, so any present-day total that
-- happened to land on the old figure was excused forever — the one class of
-- mispricing the reconciliation report could never see (whole-branch review D8).
--
-- The cutoff has to be the instant the new rounding rule started pricing orders,
-- and for every existing shop that instant is the deploy of the release
-- containing that rule — which is this migration's own application time. So it
-- is seeded with `NOW()` rather than a hardcoded date: a hardcoded one would be
-- wrong for any shop that deploys on a different day, and getting it wrong in
-- the early direction reports the shop's whole USDT history as drift.
--
-- Code treats an ABSENT or unparseable value as "exempt nothing", so a shop that
-- somehow skips this row loses the exemption rather than silently keeping the
-- open-ended one. That is the intended failure direction: noisy, not blind.
--
-- ON CONFLICT DO NOTHING so a re-run, or a shop whose admin already set the
-- field by hand, keeps the value it has. Never overwrite an operator's answer to
-- a question only they can answer.
INSERT INTO "settings" ("key", "value", "updated_at")
VALUES ('usdt_rounding_ceil_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NOW())
ON CONFLICT ("key") DO NOTHING;
