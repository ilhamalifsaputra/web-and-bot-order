/**
 * Small read helpers that replaced ad-hoc Prisma queries in route files
 * (backend audit 2026-10, task E1): orders' Digiflazz snapshot, a Binance
 * ledger row by transfer id, a buyer's open-ticket count, and the catalog
 * product lookups the CSV import and the storefront help form use.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { Decimal } from "@app/core/money";
import { upsertUser } from "./users";
import { createCategory, createCatalogProduct, createDenomination, findCatalogProductByName, listActiveProductOptions, setCatalogProductArchived, updateCatalogProduct } from "./catalog";
import { bulkAddStock } from "./stock";
import { createOrderDirect, getOrderDigiflazzSnapshot } from "./orders";
import { getProcessedBinanceTx } from "./binance_internal";
import { createTicket, closeTicket, countOpenUserTickets, addTicketMessage, isTicketAttachmentFileId } from "./support";
import { SenderType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

const newUser = () => upsertUser(prisma, { telegramId: Math.floor(Math.random() * 1_000_000_000), username: null, fullName: null });

describe("getOrderDigiflazzSnapshot", () => {
  it("returns the order's status and Digiflazz fields, or null for an unknown id", async () => {
    const cat = await createCategory(prisma, `c${Math.random()}`);
    const p = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Snap" });
    const d = await createDenomination(prisma, { productId: p.id, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "5" });
    await bulkAddStock(prisma, d.id, ["cred"]);
    const order = await createOrderDirect(prisma, { channel: "bot", user: await newUser(), productId: d.id, quantity: 1 });

    const snap = await getOrderDigiflazzSnapshot(prisma, order.id);
    expect(snap).toEqual({
      status: order.status,
      digiflazzStatus: null,
      digiflazzAttempts: 0,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: null,
      accountDiagnosticNote: null,
    });
    expect(await getOrderDigiflazzSnapshot(prisma, 2_000_000_000)).toBeNull();
  });
});

describe("getProcessedBinanceTx", () => {
  it("finds a ledger row by transfer id, or null", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "e1-tx-1", amount: new Decimal("5"), outcome: "unmatched" } });
    const row = await getProcessedBinanceTx(prisma, "e1-tx-1");
    expect(row?.amount?.toString()).toBe("5");
    expect(await getProcessedBinanceTx(prisma, "nope")).toBeNull();
  });
});

describe("countOpenUserTickets", () => {
  it("counts only that buyer's tickets that are not closed", async () => {
    const user = await newUser();
    const other = await newUser();
    await createTicket(prisma, user.id, "one");
    const closed = await createTicket(prisma, user.id, "two");
    await closeTicket(prisma, closed.id);
    await createTicket(prisma, other.id, "three");
    expect(await countOpenUserTickets(prisma, user.id)).toBe(1);
  });
});

describe("isTicketAttachmentFileId", () => {
  it("is true only for a file id attached to a ticket or one of its messages, matched exactly", async () => {
    const user = await newUser();
    const ticket = await createTicket(prisma, user.id, "see photo", "E1_TICKET_A,E1_TICKET_B");
    await addTicketMessage(prisma, { ticketId: ticket.id, senderType: SenderType.USER, senderId: user.id, content: "more", photoFileIds: "E1_MSG_C" });

    expect(await isTicketAttachmentFileId(prisma, "E1_TICKET_A")).toBe(true);
    expect(await isTicketAttachmentFileId(prisma, "E1_TICKET_B")).toBe(true);
    expect(await isTicketAttachmentFileId(prisma, "E1_MSG_C")).toBe(true);
    // A payment proof (or any other file the bot can see) is not an attachment.
    expect(await isTicketAttachmentFileId(prisma, "E1_PAYMENT_PROOF")).toBe(false);
    // Substrings and LIKE wildcards never match.
    expect(await isTicketAttachmentFileId(prisma, "E1_TICKET")).toBe(false);
    expect(await isTicketAttachmentFileId(prisma, "E1_TICKET_%")).toBe(false);
    expect(await isTicketAttachmentFileId(prisma, "E1_TICKET__")).toBe(false);
    expect(await isTicketAttachmentFileId(prisma, "")).toBe(false);
  });
});

describe("catalog product lookups", () => {
  it("findCatalogProductByName matches name within one category only", async () => {
    const a = await createCategory(prisma, `a${Math.random()}`);
    const b = await createCategory(prisma, `b${Math.random()}`);
    const p = await createCatalogProduct(prisma, { categoryId: a.id, name: "Netflix" });
    expect((await findCatalogProductByName(prisma, a.id, "Netflix"))?.id).toBe(p.id);
    expect(await findCatalogProductByName(prisma, b.id, "Netflix")).toBeNull();
  });

  it("listActiveProductOptions lists active, unarchived products by name with id and name only", async () => {
    const cat = await createCategory(prisma, `o${Math.random()}`);
    const zed = await createCatalogProduct(prisma, { categoryId: cat.id, name: "zz-E1-Zed" });
    const alpha = await createCatalogProduct(prisma, { categoryId: cat.id, name: "zz-E1-Alpha" });
    const archived = await createCatalogProduct(prisma, { categoryId: cat.id, name: "zz-E1-Archived" });
    await setCatalogProductArchived(prisma, archived.id, true);
    const inactive = await createCatalogProduct(prisma, { categoryId: cat.id, name: "zz-E1-Inactive" });
    await updateCatalogProduct(prisma, inactive.id, { isActive: false });

    const options = (await listActiveProductOptions(prisma)).filter((o) => o.name.startsWith("zz-E1-"));
    expect(options).toEqual([
      { id: alpha.id, name: "zz-E1-Alpha" },
      { id: zed.id, name: "zz-E1-Zed" },
    ]);
  });
});
