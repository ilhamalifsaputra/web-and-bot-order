// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting, prisma } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { resetBotIdentity } from "@app/core/runtime";
import { joinGate, joinGateCacheSize, pruneJoinGateCache } from "../src/middleware";
import { makeCtx } from "./helpers/ctx";

/**
 * Regression coverage for task-8-brief.md: the module-level `joinGateCache`
 * Map in middleware.ts's joinGate leaked one entry per unique Telegram user
 * for the life of the process — a verdict is only ever refreshed on that
 * same user's next update, never actively removed, so a user who is checked
 * once and never returns leaves a permanent stale entry. pruneJoinGateCache
 * is the fix's active cleanup path, mirroring sweepRateLimitBuckets.
 *
 * Fake timers are only switched on right before the synchronous prune call
 * (after all the real async DB setup below), so they never intercept any
 * timer Prisma/the DB driver relies on internally.
 */
describe("joinGate — cache sweep", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    resetBotIdentity();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stale verdict is reclaimed once its TTL elapses and the sweep runs, without ever being read again", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const userId = 700_001;
    const { ctx } = makeCtx({ from: { id: userId }, getChatMember: async () => ({ status: "left" }) });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);
    const sizeBefore = joinGateCacheSize();
    expect(sizeBefore).toBeGreaterThan(0);

    // Past the 5-minute TTL. Never read again via joinGate (which would only
    // have refreshed this same user's entry) — only pruneJoinGateCache touches it.
    const realNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(realNow + 6 * 60 * 1000);
    pruneJoinGateCache();

    expect(joinGateCacheSize()).toBe(sizeBefore - 1);
  });

  it("a fresh verdict survives the sweep (not expired yet)", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const userId = 700_002;
    const { ctx } = makeCtx({ from: { id: userId }, getChatMember: async () => ({ status: "left" }) });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);
    const sizeBefore = joinGateCacheSize();

    pruneJoinGateCache(); // runs immediately, well within the TTL

    expect(joinGateCacheSize()).toBe(sizeBefore);
  });
});
