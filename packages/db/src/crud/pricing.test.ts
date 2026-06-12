import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { getSetting, setSetting } from "./settings";
import {
  refreshUsdIdrRate,
  setFxRateFetcher,
  USD_IDR_RATE_KEY,
  USD_IDR_RATE_AUTO_KEY,
  USD_IDR_RATE_ROUNDING_KEY,
} from "./pricing";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.setting.deleteMany();
  setFxRateFetcher(async () => new Decimal("16243.7"));
});

describe("refreshUsdIdrRate (market rate + rounding — plan.md §15.8)", () => {
  it("saves the market rate rounded to the default Rp100 step", async () => {
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("honors a custom rounding step", async () => {
    await setSetting(prisma, USD_IDR_RATE_ROUNDING_KEY, "500");
    await refreshUsdIdrRate(prisma);
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000"); // nearest 500
  });

  it("reports unchanged when the rounded rate already matches", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("unchanged");
  });

  it("auto switch: 'false' disables the scheduled path, force overrides it", async () => {
    await setSetting(prisma, USD_IDR_RATE_AUTO_KEY, "false");
    expect((await refreshUsdIdrRate(prisma)).status).toBe("disabled");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBeNull(); // untouched
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("a failing fetch throws and leaves the saved rate alone", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    setFxRateFetcher(async () => {
      throw new Error("network down");
    });
    await expect(refreshUsdIdrRate(prisma, { force: true })).rejects.toThrow();
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
  });
});
