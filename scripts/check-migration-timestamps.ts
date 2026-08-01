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
 * The allowlist pins the EXACT folder names, not just the timestamp. Keying it
 * on the timestamp alone would leave the one date most likely to be reused by
 * accident — the date that already appears twice in the tree — as the only
 * date with no protection at all: a third folder could join the pair and pass
 * silently. Anything other than the exact recorded set fails.
 *
 * Run standalone: `pnpm run check-migration-timestamps`
 * Also runs automatically as part of `pretest`, next to the drift check.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

interface GrandfatheredCollision {
  /** The complete set of folders expected on this timestamp. Set equality is required. */
  folders: string[];
  /** Why this specific pair is safe to leave colliding. */
  reason: string;
}

/**
 * Timestamps allowed to appear more than once, each pinned to its exact folder
 * set and the reason it is safe. Add to this only after verifying the
 * colliding migrations cannot depend on each other's output in either order.
 */
const GRANDFATHERED: Record<string, GrandfatheredCollision> = {
  "20260725000000": {
    folders: [
      "20260725000000_add_support_ticket_priority",
      "20260725000000_add_ticket_priority_category_resolved",
    ],
    reason:
      "Both landed on the same day from two independently merged branches. " +
      "They touch disjoint columns and indexes (priority + " +
      "ix_support_tickets_priority versus category/first_response_at/" +
      "resolved_at/last_status_change_at + ix_support_tickets_status) and " +
      "neither reads the other's output, so both orderings produce an " +
      "identical schema — verified by deploying the chain with the pair " +
      "forced into the reverse order (H-9, 2026-08-01). Left unrenamed " +
      "because renaming an applied migration folder breaks " +
      "_prisma_migrations tracking on databases that already ran it.",
  },
};

const migrationsDir = join(process.cwd(), "prisma", "migrations");

const foldersByTimestamp = new Map<string, string[]>();
let folderCount = 0;
for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  folderCount += 1;
  const timestamp = entry.name.split("_")[0];
  const existing = foldersByTimestamp.get(timestamp);
  if (existing) existing.push(entry.name);
  else foldersByTimestamp.set(timestamp, [entry.name]);
}

const problems: string[] = [];

/** Collisions on a timestamp that has no allowlist entry at all. */
for (const [timestamp, folders] of foldersByTimestamp) {
  if (folders.length < 2) continue;
  if (timestamp in GRANDFATHERED) continue;
  problems.push(
    `  ${timestamp} is used by ${folders.length} folders, none of them allowlisted: ` +
      `${[...folders].sort().join(", ")}`,
  );
}

/**
 * Allowlisted timestamps whose folder set has drifted — a third folder joined
 * the pair, one was renamed, or the collision was resolved and the entry is
 * now stale. Each of those needs a human decision, so none of them may pass.
 */
for (const [timestamp, entry] of Object.entries(GRANDFATHERED)) {
  const observed = [...(foldersByTimestamp.get(timestamp) ?? [])].sort();
  const expected = [...entry.folders].sort();
  const added = observed.filter((f) => !expected.includes(f));
  const removed = expected.filter((f) => !observed.includes(f));
  if (added.length === 0 && removed.length === 0) continue;
  problems.push(
    `  ${timestamp} is allowlisted for an exact set of ${expected.length} folders, ` +
      `but the tree does not match:` +
      added.map((f) => `\n      unexpected extra folder: ${f}`).join("") +
      removed.map((f) => `\n      allowlisted folder not found: ${f}`).join(""),
  );
}

if (problems.length > 0) {
  console.error(
    "Migration folders share a timestamp prefix in a way nobody has signed " +
      "off on, so the order Prisma applies them in is decided by their " +
      "descriptive slug rather than by intent:",
  );
  for (const problem of problems) console.error(problem);
  console.error(
    "Give the newcomer a distinct, later timestamp before it has been applied " +
      "anywhere. If it has already been applied to a live database, renaming " +
      "the folder will break that database's _prisma_migrations tracking — in " +
      "that case update GRANDFATHERED in scripts/check-migration-timestamps.ts " +
      "to the new exact folder set, with the evidence that every ordering of " +
      "that set is equivalent. If a collision was resolved by renaming, delete " +
      "its allowlist entry.",
  );
  process.exit(1);
}

const collisionCount = [...foldersByTimestamp.values()].filter((f) => f.length > 1).length;
console.log(
  `Checked ${folderCount} migration folders across ${foldersByTimestamp.size} distinct ` +
    `timestamps` +
    (collisionCount > 0
      ? `; ${collisionCount} grandfathered collision(s) matched their allowlisted folder set exactly.`
      : "; no collisions."),
);
