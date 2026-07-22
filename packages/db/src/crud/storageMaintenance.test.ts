/**
 * Storage-efficiency cleanup — see docs/superpowers/specs (Storage Efficiency
 * Program). Covers the pure-DB prune/list/clear helpers plus the
 * `runStorageCleanup` orchestrator, which also touches disk (uploads dir).
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  upsertUser,
  createCategory,
  createCatalogProduct,
  createDenomination,
  addToCart,
} from "@app/db";
import {
  pruneSentOutbox,
  pruneExpiredPasswordResetTokens,
  pruneStaleCarts,
  listBroadcastsForImageCleanup,
  clearBroadcastImage,
  listTicketsForAttachmentCleanup,
  clearTicketAttachments,
  checkpointWal,
  runStorageCleanup,
} from "./storageMaintenance";
import { TicketStatus, SenderType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3_600_000);

async function makeUser() {
  return prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
}

beforeEach(async () => {
  await prisma.ticketMessage.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.notificationOutbox.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
});

describe("pruneSentOutbox", () => {
  it("deletes terminal (SENT/FAILED) rows older than cutoff, keeps everything else", async () => {
    const cutoff = daysAgo(30);
    await prisma.notificationOutbox.createMany({
      data: [
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "SENT", createdAt: daysAgo(40) },
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "SENT", createdAt: daysAgo(5) },
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "FAILED", createdAt: daysAgo(40) },
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "PENDING", createdAt: daysAgo(40) },
      ],
    });

    const count = await pruneSentOutbox(prisma, cutoff);

    expect(count).toBe(2);
    const remaining = await prisma.notificationOutbox.findMany({ orderBy: { id: "asc" } });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.status).sort()).toEqual(["PENDING", "SENT"]);
  });
});

describe("pruneExpiredPasswordResetTokens", () => {
  it("deletes expired-or-used tokens, keeps live ones", async () => {
    const user = await makeUser();
    await prisma.passwordResetToken.createMany({
      data: [
        { userId: user.id, tokenHash: "expired", expiresAt: daysAgo(1) },
        { userId: user.id, tokenHash: "used", expiresAt: new Date(Date.now() + 3_600_000), usedAt: new Date() },
        { userId: user.id, tokenHash: "live", expiresAt: new Date(Date.now() + 3_600_000) },
      ],
    });

    const count = await pruneExpiredPasswordResetTokens(prisma);

    expect(count).toBe(2);
    const remaining = await prisma.passwordResetToken.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.tokenHash).toBe("live");
  });
});

describe("pruneStaleCarts", () => {
  it("deletes cart lines untouched since cutoff, keeps recently-added ones", async () => {
    const user = await makeUser();
    const category = await createCategory(prisma, "Streaming");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Netflix" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });
    await addToCart(prisma, user.id, denom.id, 1);
    await prisma.cartItem.updateMany({ where: { userId: user.id }, data: { addedAt: daysAgo(40) } });

    const denom2 = await createDenomination(prisma, {
      productId: product.id,
      name: "3 Months",
      type: "SHARED",
      durationLabel: "3 Months",
      price: "25000",
    });
    await addToCart(prisma, user.id, denom2.id, 1); // freshly added, addedAt = now

    const count = await pruneStaleCarts(prisma, daysAgo(30));

    expect(count).toBe(1);
    const remaining = await prisma.cartItem.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.productId).toBe(denom2.id);
  });
});

describe("listBroadcastsForImageCleanup / clearBroadcastImage", () => {
  it("lists sent broadcasts older than cutoff with an image, ignores recent or imageless ones", async () => {
    const old = await prisma.broadcast.create({
      data: { message: "old", segment: "ALL", status: "SENT", sentAt: daysAgo(40), webImageUrl: "/uploads/broadcasts/a.png", imageFileId: "TGFILEID" },
    });
    await prisma.broadcast.create({
      data: { message: "recent", segment: "ALL", status: "SENT", sentAt: daysAgo(5), webImageUrl: "/uploads/broadcasts/b.png" },
    });
    await prisma.broadcast.create({
      data: { message: "no image", segment: "ALL", status: "SENT", sentAt: daysAgo(40), webImageUrl: null },
    });

    const eligible = await listBroadcastsForImageCleanup(prisma, daysAgo(30));

    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.id).toBe(old.id);

    await clearBroadcastImage(prisma, old.id);
    const fresh = await prisma.broadcast.findUnique({ where: { id: old.id } });
    expect(fresh!.webImageUrl).toBeNull();
    // The Telegram file_id cache is untouched — resends still work without the local file.
    expect(fresh!.imageFileId).toBe("TGFILEID");
  });
});

describe("listTicketsForAttachmentCleanup / clearTicketAttachments", () => {
  it("lists CLOSED tickets past cutoff with evidence on the ticket or any message, ignores open/recent ones", async () => {
    const user = await makeUser();
    const oldClosed = await prisma.supportTicket.create({
      data: { userId: user.id, message: "help", status: TicketStatus.CLOSED, closedAt: daysAgo(40), attachmentUrls: "/uploads/tickets/a.png" },
    });
    await prisma.ticketMessage.create({
      data: { ticketId: oldClosed.id, senderType: SenderType.USER, senderId: user.id, content: "more", attachmentUrls: "/uploads/tickets/b.mp4" },
    });
    const recentClosed = await prisma.supportTicket.create({
      data: { userId: user.id, message: "help2", status: TicketStatus.CLOSED, closedAt: daysAgo(5), attachmentUrls: "/uploads/tickets/c.png" },
    });
    const oldOpen = await prisma.supportTicket.create({
      data: { userId: user.id, message: "help3", status: TicketStatus.OPEN, attachmentUrls: "/uploads/tickets/d.png" },
    });
    const oldClosedNoEvidence = await prisma.supportTicket.create({
      data: { userId: user.id, message: "help4", status: TicketStatus.CLOSED, closedAt: daysAgo(40) },
    });

    const eligible = await listTicketsForAttachmentCleanup(prisma, daysAgo(30));

    expect(eligible.map((t) => t.id)).toEqual([oldClosed.id]);
    expect(eligible[0]!.messages).toHaveLength(1);
    void recentClosed;
    void oldOpen;
    void oldClosedNoEvidence;

    await clearTicketAttachments(prisma, oldClosed.id);
    const freshTicket = await prisma.supportTicket.findUnique({ where: { id: oldClosed.id } });
    const freshMessages = await prisma.ticketMessage.findMany({ where: { ticketId: oldClosed.id } });
    expect(freshTicket!.attachmentUrls).toBeNull();
    expect(freshMessages.every((m) => m.attachmentUrls === null)).toBe(true);
  });
});

describe("checkpointWal", () => {
  it("runs without throwing", async () => {
    await expect(checkpointWal(prisma)).resolves.not.toThrow();
  });
});

describe("runStorageCleanup", () => {
  let uploadsDir: string;

  beforeEach(() => {
    uploadsDir = mkdtempSync(join(tmpdir(), "uploads-"));
    mkdirSync(join(uploadsDir, "broadcasts"), { recursive: true });
    mkdirSync(join(uploadsDir, "tickets"), { recursive: true });
  });

  afterAll(() => {
    // best-effort; each test gets a fresh dir via beforeEach
  });

  it("deletes eligible files from disk, clears their DB references, prunes rows, tolerates already-missing files", async () => {
    writeFileSync(join(uploadsDir, "broadcasts", "old.png"), "old-image");
    writeFileSync(join(uploadsDir, "broadcasts", "recent.png"), "recent-image");
    writeFileSync(join(uploadsDir, "tickets", "evidence-a.png"), "evidence-a");
    // evidence-b.mp4 deliberately NOT written — file already missing on disk.

    const user = await makeUser();
    const oldBroadcast = await prisma.broadcast.create({
      data: { message: "old", segment: "ALL", status: "SENT", sentAt: daysAgo(40), webImageUrl: "/uploads/broadcasts/old.png" },
    });
    const recentBroadcast = await prisma.broadcast.create({
      data: { message: "recent", segment: "ALL", status: "SENT", sentAt: daysAgo(5), webImageUrl: "/uploads/broadcasts/recent.png" },
    });
    const oldTicket = await prisma.supportTicket.create({
      data: {
        userId: user.id,
        message: "help",
        status: TicketStatus.CLOSED,
        closedAt: daysAgo(40),
        attachmentUrls: "/uploads/tickets/evidence-a.png",
      },
    });
    await prisma.ticketMessage.create({
      data: { ticketId: oldTicket.id, senderType: SenderType.USER, senderId: user.id, content: "more", attachmentUrls: "/uploads/tickets/evidence-b.mp4" },
    });
    await prisma.notificationOutbox.createMany({
      data: [
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "SENT", createdAt: daysAgo(40) },
        { event: "ORDER_DELIVERED", payloadJson: "{}", status: "SENT", createdAt: daysAgo(5) },
      ],
    });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: "expired", expiresAt: daysAgo(1) },
    });
    const category = await createCategory(prisma, "Streaming");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Netflix" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });
    await addToCart(prisma, user.id, denom.id, 1);
    await prisma.cartItem.updateMany({ where: { userId: user.id }, data: { addedAt: daysAgo(40) } });

    const summary = await runStorageCleanup(prisma, uploadsDir, 30);

    expect(summary).toEqual({
      broadcastFilesDeleted: 1,
      ticketFilesDeleted: 1,
      outboxRowsDeleted: 1,
      resetTokensDeleted: 1,
      cartsDeleted: 1,
    });

    expect(existsSync(join(uploadsDir, "broadcasts", "old.png"))).toBe(false);
    expect(existsSync(join(uploadsDir, "broadcasts", "recent.png"))).toBe(true);
    expect(existsSync(join(uploadsDir, "tickets", "evidence-a.png"))).toBe(false);

    const freshOldBroadcast = await prisma.broadcast.findUnique({ where: { id: oldBroadcast.id } });
    const freshRecentBroadcast = await prisma.broadcast.findUnique({ where: { id: recentBroadcast.id } });
    expect(freshOldBroadcast!.webImageUrl).toBeNull();
    expect(freshRecentBroadcast!.webImageUrl).toBe("/uploads/broadcasts/recent.png");

    const freshTicket = await prisma.supportTicket.findUnique({ where: { id: oldTicket.id } });
    expect(freshTicket!.attachmentUrls).toBeNull();

    expect(await prisma.notificationOutbox.count()).toBe(1);
    expect(await prisma.passwordResetToken.count()).toBe(0);
    expect(await prisma.cartItem.count()).toBe(0);
  });
});
