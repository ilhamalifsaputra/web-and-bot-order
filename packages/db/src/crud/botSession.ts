/**
 * grammY session storage — CRUD layer backing
 * `apps/order-bot/src/util/prismaSessionStorage.ts`'s `StorageAdapter<SessionData>`
 * implementation. See `prisma/schema.prisma`'s `BotSession` doc comment for
 * the table's shape/rationale (including the Phase B landmine this
 * migration's `conversation.external()` audit guards against) and the
 * `kind`-based TTL split (24h "nav" / 15min "checkout").
 *
 * This module deliberately knows nothing about grammY, `SessionData`, or the
 * TTL values themselves — those decisions live in `prismaSessionStorage.ts`
 * (the adapter) and `context.ts` (the session shape). Keeping this layer a
 * plain string-in/string-out CRUD module, like every other `crud/*.ts` file,
 * means the adapter is the only place a JSON encode/decode bug or a bad TTL
 * choice could live.
 */
import type { Db } from "./_types";

export type BotSessionKind = "nav" | "checkout";

/**
 * Read a session's raw (still-JSON-encoded) `data`, or `undefined` if the
 * key doesn't exist or its TTL has already passed `now`. An expired row is
 * lazily deleted here (best-effort — see the swallowed catch) instead of
 * left for the daily prune job, so a repeat read of the same stale key
 * doesn't keep finding (and re-checking) a dead row until the next sweep.
 */
export async function readBotSession(db: Db, key: string, now: Date = new Date()): Promise<string | undefined> {
  const row = await db.botSession.findUnique({ where: { key } });
  if (!row) return undefined;
  if (row.expiresAt <= now) {
    // Best-effort: a concurrent write/delete racing this is harmless either
    // way (worst case the daily prune job catches the row instead).
    await db.botSession.deleteMany({ where: { key } }).catch(() => undefined);
    return undefined;
  }
  return row.data;
}

/** Upsert a session's `data`, stamping `expiresAt` and `kind` as given —
 * the caller (the adapter) computes both from the session content and the
 * TTL split, this function just persists them. */
export async function writeBotSession(
  db: Db,
  key: string,
  data: string,
  kind: BotSessionKind,
  expiresAt: Date,
): Promise<void> {
  await db.botSession.upsert({
    where: { key },
    create: { key, data, kind, expiresAt },
    update: { data, kind, expiresAt },
  });
}

/** Delete a session row outright (grammY calls this when a handler sets
 * `ctx.session = null`/`undefined`). A no-op if the key doesn't exist. */
export async function deleteBotSession(db: Db, key: string): Promise<void> {
  await db.botSession.deleteMany({ where: { key } });
}

/** Delete every session row whose TTL has passed `cutoff` (normally "now").
 * Returns the count removed — see `cleanupExpiredBotSessionsJob`, jobs/index.ts. */
export async function pruneExpiredBotSessions(db: Db, cutoff: Date): Promise<number> {
  const { count } = await db.botSession.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}
