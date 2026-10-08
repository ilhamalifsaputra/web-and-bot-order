-- No data is merged or deleted. Run the duplicate audit BEFORE deployment.
ALTER TABLE denominations ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE denominations ADD CONSTRAINT denominations_archive_inactive
  CHECK (NOT is_archived OR NOT is_active);
