import { createHash } from "node:crypto";
import type { Db } from "./_types";
import { emailTransaction, enqueueEmailEvent } from "./emailEvents";

/** Five failed password verifications in ten minutes, one alert per hour; ordinary logins do not qualify. */
export async function recordEmailLoginFailure(db: Db, userId: number, now = new Date()): Promise<void> {
  return emailTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true, banned: true } });
    if (!user?.passwordHash || user.banned) return;
    const key = `email_login_failures:${userId}`;
    const row = await tx.setting.findUnique({ where: { key } });
    const prev: { attempts: number[]; alertedAt: number } = row ? JSON.parse(row.value) : { attempts: [], alertedAt: 0 };
    const attempts = [...prev.attempts.filter((at) => at > now.getTime() - 600_000), now.getTime()].slice(-5);
    const alert = attempts.length >= 5 && now.getTime() - prev.alertedAt >= 3_600_000;
    const alertedAt = alert ? now.getTime() : prev.alertedAt;
    await tx.setting.upsert({ where: { key }, create: { key, value: JSON.stringify({ attempts, alertedAt }) }, update: { value: JSON.stringify({ attempts, alertedAt }) } });
    if (alert) await enqueueEmailEvent(tx, { key: "security.login.suspicious", aggregateId: userId, occurrence: alertedAt, userId });
  });
}
export async function clearEmailLoginFailures(db: Db, userId: number): Promise<void> {
  return emailTransaction(db, async (tx) => {
    // Use the same lock as failed verifications so a successful login cannot
    // overwrite a concurrent failure or discard the alert cooldown.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const key = `email_login_failures:${userId}`;
    const row = await tx.setting.findUnique({ where: { key } });
    if (!row) return;
    const prev = JSON.parse(row.value) as { alertedAt: number };
    await tx.setting.update({ where: { key }, data: { value: JSON.stringify({ attempts: [], alertedAt: prev.alertedAt }) } });
  });
}
export const passwordChangeOccurrence = (hash: string) => createHash("sha256").update(hash).digest("hex");

/** Three observed failed operations within ten minutes open an incident; one hour cooldown, recovery closes episode. */
export async function recordEmailProviderHealth(db: Db, provider: string, success: boolean, now = new Date()): Promise<void> {
  return emailTransaction(db, async (tx) => {
    const key = `email_provider_incident:${provider}`;
    // Prisma emulates an empty-update upsert with a read followed by insert;
    // concurrent first observations would collide before the row lock below.
    await tx.setting.createMany({ data: [{ key, value: JSON.stringify({ failures: [], openedAt: 0, open: false }) }], skipDuplicates: true });
    await tx.$queryRaw`SELECT key FROM settings WHERE key = ${key} FOR UPDATE`;
    const row = await tx.setting.findUniqueOrThrow({ where: { key } });
    const prev = JSON.parse(row.value) as { failures: number[]; openedAt: number; open: boolean };
    const failures = success ? [] : [...prev.failures.filter((at) => at > now.getTime() - 600_000), now.getTime()].slice(-3);
    const opened = !success && failures.length >= 3 && !prev.open && now.getTime() - prev.openedAt >= 3_600_000;
    const state = { failures, openedAt: opened ? now.getTime() : prev.openedAt, open: success ? false : opened || prev.open };
    await tx.setting.update({ where: { key }, data: { value: JSON.stringify(state) } });
    if (opened) await enqueueEmailEvent(tx, { key: "provider.incident.opened", aggregateId: provider, occurrence: state.openedAt, payload: { provider, failure_count: failures.length, window_minutes: 10 } });
  });
}
