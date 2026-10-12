import { config } from "@app/core/config";
import { DateTime } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import type { EmailEventKey } from "@app/core/email";
import type { Db } from "./_types";
import { emailTransaction, enqueueEmailEvent } from "./emailEvents";
import { isEmailEventEnabled } from "./emailPolicy";
import { grossSalesForNetSales, refundTotalsSince, revenueSummary } from "./revenue";

export interface EmailReportSchedule { timezone: string; dailyTime: string; weeklyDay: number; weeklyTime: string }
export function validateEmailSchedule(value: unknown): value is EmailReportSchedule {
  if (!value || typeof value !== "object") return false;
  const row = value as EmailReportSchedule;
  return typeof row.timezone === "string" && DateTime.now().setZone(row.timezone).isValid &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(row.dailyTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(row.weeklyTime) && Number.isInteger(row.weeklyDay) && row.weeklyDay >= 0 && row.weeklyDay <= 6;
}
export async function getEmailReportSchedule(db: Db): Promise<EmailReportSchedule> {
  const row = await db.setting.findUnique({ where: { key: "email_report_schedule" } });
  if (row) { const parsed: unknown = JSON.parse(row.value); if (validateEmailSchedule(parsed)) return parsed; }
  return { timezone: config.TIMEZONE, dailyTime: "00:00", weeklyDay: 1, weeklyTime: "00:00" };
}
/** Reports always describe calendar days/weeks; configured delivery time never shifts the sales period. */
export function closedEmailReportPeriods(now: Date, schedule: EmailReportSchedule) {
  const local = DateTime.fromJSDate(now).setZone(schedule.timezone);
  const [dailyHour, dailyMinute] = schedule.dailyTime.split(":").map(Number);
  const dailyDue = local.startOf("day").set({ hour: dailyHour, minute: dailyMinute });
  const dailyEnd = local >= dailyDue ? local.startOf("day") : local.startOf("day").minus({ days: 1 });
  const [weeklyHour, weeklyMinute] = schedule.weeklyTime.split(":").map(Number);
  const weekStart = local.startOf("week");
  const dayOffset = (schedule.weeklyDay + 6) % 7;
  const weeklyDue = weekStart.plus({ days: dayOffset }).set({ hour: weeklyHour, minute: weeklyMinute });
  const weeklyEnd = local >= weeklyDue ? weekStart : weekStart.minus({ weeks: 1 });
  return [
    { key: "report.daily_sales_inventory" as const, start: dailyEnd.minus({ days: 1 }).toUTC().toJSDate(), end: dailyEnd.toUTC().toJSDate() },
    { key: "report.weekly_revenue" as const, start: weeklyEnd.minus({ weeks: 1 }).toUTC().toJSDate(), end: weeklyEnd.toUTC().toJSDate() },
  ];
}
export async function queueEmailReports(db: Db, now = new Date()): Promise<number> {
  const schedule = await getEmailReportSchedule(db);
  let queued = 0;
  for (const period of closedEmailReportPeriods(now, schedule)) {
    if (!(await isEmailEventEnabled(db, period.key))) continue;
    const enabledAt = await db.setting.findUnique({ where: { key: `email_report_enabled_at:${period.key}` } });
    // Without an activation marker establish one, never mail historical periods on deployment.
    if (!enabledAt) {
      await db.setting.createMany({ data: [{ key: `email_report_enabled_at:${period.key}`, value: now.toISOString() }], skipDuplicates: true });
      continue;
    }
    if (period.end <= new Date(enabledAt.value)) continue;
    const occurrence = `${period.start.toISOString()}:${period.end.toISOString()}:${schedule.timezone}`;
    const cursorKey = `email_report_period:${period.key}`;
    if ((await db.setting.findUnique({ where: { key: cursorKey } }))?.value === occurrence) continue;
    const inclusiveEnd = new Date(period.end.getTime() - 1);
    const [sales, gross, refunds, statuses, stocks] = await Promise.all([
      revenueSummary(db, period.start, inclusiveEnd), grossSalesForNetSales(db, period.start, inclusiveEnd), refundTotalsSince(db, period.start, inclusiveEnd),
      db.order.groupBy({ by: ["status"], where: { kind: "PRODUCT", createdAt: { gte: period.start, lt: period.end } }, _count: { _all: true } }),
      db.denomination.findMany({ where: { deliveryType: "auto", OR: [{ autoDeliverySource: null }, { autoDeliverySource: { in: ["stock", "STOCK"] } }] }, select: { id: true, _count: { select: { stockItems: { where: { deletedAt: null, status: "AVAILABLE" } } } } } }),
    ]);
    let low = 0, out = 0;
    const thresholdRows = await db.setting.findMany({ where: { key: { startsWith: "email_inventory_critical_threshold:" } } });
    for (const sku of stocks) { const count = sku._count.stockItems; const threshold = Number(thresholdRows.find((r) => r.key.endsWith(`:${sku.id}`))?.value ?? 3); if (count === 0) out++; else if (count <= threshold) low++; }
    const native = (idr: Decimal, usdt: Decimal) => `${idr.toString()} IDR; ${usdt.toString()} USDT`;
    const payload = { period_start: period.start.toISOString(), period_end: period.end.toISOString(), timezone: schedule.timezone,
      completed_count: sales.orders, revenue: native(gross.idr, gross.usdt), refunds: native(refunds.refunds_idr, refunds.refunds_usdt),
      net_revenue: native(gross.idr.minus(refunds.refunds_idr), gross.usdt.minus(refunds.refunds_usdt)), inventory_low: low, inventory_out: out,
      payment_statuses: statuses.map((r) => `${r.status}: ${r._count._all}`).join("; "),
      report_definition: "Gross: delivered/refunded product sales including wallet spend. Net: gross minus executed refund payouts. Currency totals are separate; no assumed profit or provider fees. Inventory is the current available local stock snapshot.",
    };
    queued += await emailTransaction(db, async (tx) => {
      const result = await enqueueEmailEvent(tx, { key: period.key as EmailEventKey, aggregateId: period.key, occurrence, payload });
      await tx.setting.upsert({ where: { key: cursorKey }, create: { key: cursorKey, value: occurrence }, update: { value: occurrence } });
      return result ? 1 : 0;
    });
  }
  return queued;
}
