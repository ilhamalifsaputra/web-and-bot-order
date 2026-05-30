/**
 * One-time data migration: convert SQLAlchemy TEXT datetimes
 * ("YYYY-MM-DD HH:MM:SS[.ffffff]", UTC) → Prisma's SQLite format
 * (INTEGER epoch milliseconds). Required because Prisma's SQLite connector
 * stores/reads DateTime as int-ms and cannot parse the Python TEXT format
 * (errors with P2023 "Conversion failed: input contains invalid characters").
 *
 * Usage:
 *   tsx scripts/convert-datetimes.ts                 # dry-run preview
 *   tsx scripts/convert-datetimes.ts --apply         # backup + convert
 *   tsx scripts/convert-datetimes.ts --apply --url "file:/app/data/bot.db"
 *
 * Idempotent: only rows whose column is still TEXT are converted, so re-running
 * is safe. Keep the auto-created backup for rollback (Python reads TEXT, not
 * int-ms, so reverting to the Python stack requires restoring the backup).
 */
import { copyFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

// Every DateTime column in prisma/schema.prisma, keyed by its SQL table name.
const DATETIME_COLUMNS: Record<string, string[]> = {
  users: ["created_at", "last_seen_at"],
  products: ["created_at"],
  stock_items: ["added_at", "reserved_at", "sold_at"],
  orders: ["created_at", "expires_at", "paid_at", "delivered_at"],
  vouchers: ["expires_at", "created_at"],
  reviews: ["created_at"],
  referrals: ["created_at"],
  support_tickets: ["created_at", "replied_at"],
  ticket_messages: ["created_at"],
  restock_subscriptions: ["created_at"],
  cart_items: ["added_at"],
  bulk_pricing: ["created_at"],
  settings: ["updated_at"],
  audit_logs: ["created_at"],
  notification_outbox: ["created_at", "sent_at"],
};

const APPLY = process.argv.includes("--apply");
const urlArg = process.argv.indexOf("--url");
const URL = urlArg !== -1 ? process.argv[urlArg + 1]! : "file:../data/bot.db";

const p = new PrismaClient({ datasourceUrl: URL });
const toMs = (col: string) => `CAST((julianday(${col}) - 2440587.5) * 86400000.0 AS INTEGER)`;

async function main() {
  console.log(`DB: ${URL}  mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Preview a few values so the conversion is auditable before applying.
  const sample = await p.$queryRawUnsafe<{ src: string | null; ms: bigint | null }[]>(
    `SELECT CAST(created_at AS TEXT) src, ${toMs("created_at")} ms FROM users WHERE typeof(created_at)='text' LIMIT 3`,
  );
  for (const s of sample) {
    console.log(`  e.g. users.created_at: ${s.src} -> ${s.ms} -> ${s.ms ? new Date(Number(s.ms)).toISOString() : "—"}`);
  }

  if (APPLY) {
    const backup = URL.replace(/^file:/, "").replace(/\//g, "\\");
    try {
      const bak = `${backup}.bak-${Date.now()}`;
      copyFileSync(backup, bak);
      console.log(`Backup written: ${bak}`);
    } catch (e) {
      console.warn(`(could not auto-backup ${backup}: ${(e as Error).message}) — ensure you have a backup!`);
    }
  }

  let totalConverted = 0;
  for (const [table, cols] of Object.entries(DATETIME_COLUMNS)) {
    for (const col of cols) {
      const [{ n }] = await p.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*) n FROM ${table} WHERE typeof(${col})='text' AND ${col} IS NOT NULL`,
      );
      const count = Number(n);
      if (count === 0) continue;
      totalConverted += count;
      if (APPLY) {
        await p.$executeRawUnsafe(
          `UPDATE ${table} SET ${col} = ${toMs(col)} WHERE typeof(${col})='text' AND ${col} IS NOT NULL`,
        );
        console.log(`  converted ${table}.${col}: ${count}`);
      } else {
        console.log(`  would convert ${table}.${col}: ${count}`);
      }
    }
  }
  console.log(`${APPLY ? "Converted" : "Would convert"} ${totalConverted} text-datetime values total.`);

  if (APPLY) {
    const u = await p.user.findFirst();
    console.log("Verify Prisma read after conversion:", u ? `user #${u.id} createdAt=${u.createdAt.toISOString()}` : "(no users)");
  }
}

main()
  .then(() => p.$disconnect())
  .catch((e) => {
    console.error("ERR", e.message ?? e);
    process.exit(1);
  });
