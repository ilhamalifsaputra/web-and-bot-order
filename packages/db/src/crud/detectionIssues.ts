/**
 * Detection Engine — review-queue crud for `DetectionIssue` (Task 9,
 * AC-20).
 *
 * `runDetectionForCatalog` (crud/detectionRun.ts) fills this table; this
 * module is the admin-facing read + review-workflow layer over it. The
 * workflow is a tiny state machine on the free-text `reviewStatus` column
 * (`OPEN` -> `RESOLVED` | `IGNORED`, both terminal) driven the same way as
 * `crud/adminTasks.ts`: an atomic `updateMany` that carries the expected
 * current status in its WHERE clause (so a stale or duplicate caller fails
 * safely instead of clobbering a row that already moved on), and a
 * `logAdminAction` audit row for every transition.
 *
 * A no-op re-call (resolving an already-`RESOLVED` issue, etc.) is a caller
 * bug, not a silent success — it raises `ValidationError` so the route
 * surfaces a 422 rather than pretending the transition happened.
 */
import { ValidationError } from "@app/core/errors";
import type { DetectionIssue } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";

/** The three review-workflow states `DetectionIssue.reviewStatus` may hold
 * (enforced here, not by the DB — same convention as Order.status /
 * AdminTask.status). `OPEN` is the schema default. */
export const DETECTION_REVIEW_OPEN = "OPEN";
export const DETECTION_REVIEW_RESOLVED = "RESOLVED";
export const DETECTION_REVIEW_IGNORED = "IGNORED";

export type DetectionIssueRow = DetectionIssue;

/**
 * Review-queue rows, most-recently-seen first. With no `reviewStatus`
 * filter every row is returned; pass `{ reviewStatus: "OPEN" }` for the
 * admin panel's default "needs attention" view.
 */
export function listDetectionIssues(
  db: Db,
  filter: { reviewStatus?: string } = {},
): Promise<DetectionIssueRow[]> {
  return db.detectionIssue.findMany({
    where: filter.reviewStatus ? { reviewStatus: filter.reviewStatus } : undefined,
    orderBy: { lastSeenAt: "desc" },
  });
}

/**
 * Move one issue from `OPEN` to `to` atomically, audit it, or raise a clear
 * `ValidationError` when the row does not exist or is no longer `OPEN`.
 */
async function transitionDetectionIssue(
  db: Db,
  id: number,
  to: typeof DETECTION_REVIEW_RESOLVED | typeof DETECTION_REVIEW_IGNORED,
  adminId: number,
): Promise<void> {
  const claim = await db.detectionIssue.updateMany({
    where: { id, reviewStatus: DETECTION_REVIEW_OPEN },
    data: { reviewStatus: to },
  });

  if (claim.count !== 1) {
    const existing = await db.detectionIssue.findUnique({ where: { id } });
    if (!existing) {
      throw new ValidationError("error.detection_issue_not_found", { id });
    }
    throw new ValidationError("error.detection_issue_not_open", {
      id,
      reviewStatus: existing.reviewStatus,
    });
  }

  await logAdminAction(db, {
    adminId,
    action: "detection_issue_review",
    targetType: "detection_issue",
    targetId: id,
    details: `Marked detection issue #${id} as ${to === DETECTION_REVIEW_RESOLVED ? "resolved" : "dismissed"}.`,
  });
}

/** Mark an OPEN issue RESOLVED (the underlying detection input is now
 * handled — e.g. a `DetectionOverride` or a knowledge-token edit was made). */
export function resolveDetectionIssue(db: Db, id: number, adminId: number): Promise<void> {
  return transitionDetectionIssue(db, id, DETECTION_REVIEW_RESOLVED, adminId);
}

/** Mark an OPEN issue IGNORED (reviewed, no action needed — e.g. a
 * deliberately unresolvable placeholder catalog row). */
export function dismissDetectionIssue(db: Db, id: number, adminId: number): Promise<void> {
  return transitionDetectionIssue(db, id, DETECTION_REVIEW_IGNORED, adminId);
}
