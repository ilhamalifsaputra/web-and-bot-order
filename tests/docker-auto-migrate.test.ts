import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

loadEnv();
const ticketingSql = readFileSync(new URL("../deploy/sql/ticketing-upgrade.sql", import.meta.url), "utf8");
const denominationSql = readFileSync(new URL("../deploy/sql/denomination-integrity.sql", import.meta.url), "utf8");
let prisma: PrismaClient;
let schema: string;

// Minimal historical tables let these tests exercise the actual upgrade SQL,
// rather than starting from today's schema (which would hide missing backfills).
beforeEach(async () => {
  schema = `test_docker_migrate_${randomBytes(6).toString("hex")}`;
  const url = new URL(process.env.DATABASE_URL_PRISMA!);
  url.searchParams.set("schema", schema);
  prisma = new PrismaClient({ datasourceUrl: url.toString() });
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
});

afterEach(async () => {
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
});

async function createLegacyTickets() {
  await prisma.$executeRawUnsafe(`CREATE TABLE support_tickets (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
    created_at TIMESTAMP(3) NOT NULL, last_status_change_at TIMESTAMP(3),
    replied_at TIMESTAMP(3), resolved_at TIMESTAMP(3), closed_at TIMESTAMP(3)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE ticket_messages (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, sender_id INTEGER,
    created_at TIMESTAMP(3) NOT NULL
  )`);
  await prisma.$executeRawUnsafe(`INSERT INTO support_tickets (id, user_id, created_at, replied_at)
    VALUES (1, 42, '2026-01-01', '2026-01-02'), (2, 42, '2026-01-01', NULL)`);
  await prisma.$executeRawUnsafe(`INSERT INTO ticket_messages VALUES (1, 1, 42, '2026-01-03')`);
}

async function createDenominations() {
  await prisma.$executeRawUnsafe(`CREATE TABLE denominations (
    id INTEGER PRIMARY KEY, auto_delivery_source TEXT, supplier_sku TEXT,
    is_archived BOOLEAN NOT NULL DEFAULT false, is_active BOOLEAN NOT NULL DEFAULT true
  )`);
}

describe("Docker ticketing upgrade", () => {
  it("allows an empty database, leaving table creation to schema push", async () => {
    await prisma.$executeRawUnsafe(ticketingSql);
    const tables = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('support_tickets')::text AS name`;
    expect(tables).toEqual([{ name: null }]);
  });

  it("backfills historical activity and prepares unique indexes on populated tables", async () => {
    await createLegacyTickets();
    await prisma.$executeRawUnsafe(ticketingSql);
    expect(await prisma.$queryRaw`SELECT id, last_activity_at FROM support_tickets ORDER BY id`).toEqual([
      { id: 1, last_activity_at: new Date("2026-01-03T00:00:00Z") },
      { id: 2, last_activity_at: new Date("2026-01-01T00:00:00Z") },
    ]);
    await prisma.$executeRawUnsafe(`UPDATE support_tickets SET request_key = 'same' WHERE id = 1`);
    await expect(prisma.$executeRawUnsafe(`UPDATE support_tickets SET request_key = 'same' WHERE id = 2`))
      .rejects.toMatchObject({ meta: { code: "23505" } });
    await prisma.$executeRawUnsafe(`UPDATE ticket_messages SET request_key = 'same'`);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO ticket_messages
      (id, ticket_id, sender_id, created_at, request_key) VALUES (2, 1, 42, now(), 'same')`))
      .rejects.toMatchObject({ meta: { code: "23505" } });
  });

  it("preserves newer application activity and nullable request keys on repeated starts", async () => {
    await createLegacyTickets();
    await prisma.$executeRawUnsafe(ticketingSql);
    await prisma.$executeRawUnsafe(`UPDATE support_tickets SET last_activity_at = '2026-10-13' WHERE id = 1`);
    await prisma.$executeRawUnsafe(ticketingSql);
    expect(await prisma.$queryRaw`SELECT last_activity_at FROM support_tickets WHERE id = 1`)
      .toEqual([{ last_activity_at: new Date("2026-10-13T00:00:00Z") }]);
    expect(await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM support_tickets`)
      .toEqual([{ count: 2 }]);
  });

  it("rejects duplicate ticket request keys atomically without deleting rows", async () => {
    await createLegacyTickets();
    await prisma.$executeRawUnsafe(`ALTER TABLE support_tickets ADD COLUMN request_key TEXT`);
    await prisma.$executeRawUnsafe(`UPDATE support_tickets SET request_key = 'duplicate'`);
    await expect(prisma.$executeRawUnsafe(ticketingSql)).rejects.toMatchObject({ meta: { code: "23505" } });
    expect(await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM support_tickets`)
      .toEqual([{ count: 2 }]);
    expect(await prisma.$queryRaw`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'support_tickets'
        AND column_name = 'last_activity_at'`).toEqual([]);
  });

  it("rejects duplicate message request keys without partially upgrading tickets", async () => {
    await createLegacyTickets();
    await prisma.$executeRawUnsafe(`ALTER TABLE ticket_messages ADD COLUMN request_key TEXT`);
    await prisma.$executeRawUnsafe(`UPDATE ticket_messages SET request_key = 'duplicate'`);
    await prisma.$executeRawUnsafe(`INSERT INTO ticket_messages VALUES (2, 1, 42, now(), 'duplicate')`);
    await expect(prisma.$executeRawUnsafe(ticketingSql)).rejects.toMatchObject({ meta: { code: "23505" } });
    expect(await prisma.$queryRaw`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'support_tickets'
        AND column_name = 'request_key'`).toEqual([]);
  });
});

describe("Docker denomination integrity migrations", () => {
  it("enforces supplier identity, legacy source resolution and archive checks after repeated starts", async () => {
    await createDenominations();
    await prisma.$executeRawUnsafe(denominationSql);
    await prisma.$executeRawUnsafe(denominationSql);
    await prisma.$executeRawUnsafe(`INSERT INTO denominations (id, supplier_sku) VALUES (1, 'SKU')`);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO denominations
      (id, auto_delivery_source, supplier_sku) VALUES (2, 'digiflazz', 'SKU')`))
      .rejects.toMatchObject({ meta: { code: "23505" } });
    await prisma.$executeRawUnsafe(`INSERT INTO denominations
      (id, auto_delivery_source, supplier_sku) VALUES (3, 'other', 'SKU')`);
    await prisma.$executeRawUnsafe(`INSERT INTO denominations
      (id, supplier_sku, is_archived, is_active) VALUES (4, 'SKU', true, false)`);
    await expect(prisma.$executeRawUnsafe(`UPDATE denominations SET is_active = true WHERE id = 4`))
      .rejects.toMatchObject({ meta: { code: "23514" } });
  });

  it("blocks legacy supplier collisions without modifying existing records", async () => {
    await createDenominations();
    await prisma.$executeRawUnsafe(`INSERT INTO denominations (id, supplier_sku) VALUES (1, 'SKU'), (2, 'SKU')`);
    await expect(prisma.$executeRawUnsafe(denominationSql)).rejects.toMatchObject({ meta: { code: "23505" } });
    expect(await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM denominations`)
      .toEqual([{ count: 2 }]);
  });

  it("blocks active archived records without silently repairing them", async () => {
    await createDenominations();
    await prisma.$executeRawUnsafe(`INSERT INTO denominations (id, is_archived) VALUES (1, true)`);
    await expect(prisma.$executeRawUnsafe(denominationSql)).rejects.toMatchObject({ meta: { code: "23514" } });
    expect(await prisma.$queryRaw`SELECT is_active, is_archived FROM denominations`)
      .toEqual([{ is_active: true, is_archived: true }]);
  });
});
