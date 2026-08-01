/**
 * Guard against two migration folders sharing the same timestamp prefix.
 *
 * Prisma applies `prisma/migrations/*` in plain lexicographic order of the
 * FULL folder name, so when two folders carry an identical timestamp the
 * relative order of that pair is decided by whatever comes after the
 * underscore — i.e. by the descriptive slug, which nobody chose with ordering
 * in mind. That is fine right up until the day the two migrations touch the
 * same table and one genuinely has to run first; then the chain breaks on a
 * fresh database for a reason that is invisible in the SQL itself.
 *
 * This repo already carries one such pair (H-9, see the allowlist below). It
 * was verified harmless empirically, so it is grandfathered rather than
 * renamed — renaming an already-applied folder would break `_prisma_migrations`
 * tracking on any database that ran it under the old name. What this check
 * prevents is a SECOND pair sneaking in unnoticed.
 *
 * Run standalone: `pnpm run check-migration-timestamps`
 * Also runs automatically as part of `pretest`, next to the drift check.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Timestamps allowed to appear more than once, each with the reason it is
 * safe. Add to this only after verifying the colliding migrations cannot
 * depend on each other's output in either order.
 */
const GRANDFATHERED: Record<string, string> = {
  "20260725000000":
    "add_support_ticket_priority and add_ticket_priority_category_resolved " +
    "landed on the same day from two independently merged branches. They touch " +
    "disjoint columns and indexes (priority + ix_support_tickets_priority " +
    "versus category/first_response_at/resolved_at/last_status_change_at + " +
    "ix_support_tickets_status) and neither reads the other's output, so both " +
    "orderings produce an identical schema — verified by deploying the chain " +
    "with the pair forced into the reverse order (H-9, 2026-08-01). Left " +
    "unrenamed because renaming an applied migration folder breaks " +
    "_prisma_migrations tracking on databases that already ran it.",
};

const migrationsDir = join(process.cwd(), "prisma", "migrations");

const timestamps = new Map<string, string[]>();
for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const timestamp = entry.name.split("_")[0];
  const existing = timestamps.get(timestamp);
  if (existing) existing.push(entry.name);
  else timestamps.set(timestamp, [entry.name]);
}

const unexpected = [...timestamps.entries()].filter(
  ([timestamp, folders]) => folders.length > 1 && !(timestamp in GRANDFATHERED),
);

if (unexpected.length > 0) {
  console.error(
    "Two or more migration folders share the same timestamp prefix, so the " +
      "order Prisma applies them in is decided by their descriptive slug " +
      "rather than by intent:",
  );
  for (const [timestamp, folders] of unexpected) {
    console.error(`  ${timestamp}: ${folders.sort().join(", ")}`);
  }
  console.error(
    "Give one of them a distinct, later timestamp before it has been applied " +
      "anywhere. If it has already been applied to a live database, renaming " +
      "the folder will break that database's _prisma_migrations tracking — in " +
      "that case add it to GRANDFATHERED in scripts/check-migration-timestamps.ts " +
      "with the evidence that both orderings are equivalent.",
  );
  process.exit(1);
}

const grandfatheredCount = [...timestamps.values()].filter((f) => f.length > 1).length;
console.log(
  `Migration timestamps are unique across ${timestamps.size} folders` +
    (grandfatheredCount > 0
      ? ` (${grandfatheredCount} grandfathered collision(s) allowed).`
      : "."),
);
