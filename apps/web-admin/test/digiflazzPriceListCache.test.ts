import { describe, it, expect, beforeEach, vi } from "vitest";

const digiflazzMock = vi.hoisted(() => ({ getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  getPriceList: digiflazzMock.getPriceList,
}));

import { Decimal } from "@app/core/money";
import { DigiflazzSupplierError, type DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";
import {
  getPriceListCached,
  getPriceListFresh,
  clearDigiflazzPriceListCache,
  digiflazzPriceListCacheEntryCount,
  PRICE_LIST_CACHE_TTL_MS,
  RATE_LIMIT_COOLDOWN_MS,
} from "../src/lib/digiflazzPriceListCache";

const CREDS = { username: "shop01", apiKey: "s3cr3t-key" };
const T0 = 1_000_000;

/** A clock frozen at `t`. */
const at = (t: number) => () => t;

function item(buyerSkuCode: string, price = 15000): DigiflazzPriceListItem {
  return {
    buyerSkuCode, productName: `Mobile Legends ${buyerSkuCode}`, category: "Game", brand: "Mobile Legends", type: "Umum",
    price: new Decimal(price), buyerProductStatus: true, sellerProductStatus: true, stock: null,
  } as DigiflazzPriceListItem;
}

function rateLimited(): DigiflazzSupplierError {
  return new DigiflazzSupplierError("Digiflazz refused the price-list request: Anda telah mencapai limitasi pengecekan pricelist (rc 83)", "83");
}

beforeEach(() => {
  clearDigiflazzPriceListCache();
  digiflazzMock.getPriceList.mockReset();
});

describe("getPriceListCached", () => {
  it("answers a second request within the TTL from the cache, without asking Digiflazz again", async () => {
    digiflazzMock.getPriceList.mockResolvedValue([item("ml100")]);
    const first = await getPriceListCached(CREDS, at(T0));
    const second = await getPriceListCached(CREDS, at(T0 + PRICE_LIST_CACHE_TTL_MS - 1));
    expect(second.map((i) => i.buyerSkuCode)).toEqual(["ml100"]);
    expect(second).toEqual(first);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledWith(CREDS);
  });

  it("fetches a fresh list once the TTL has passed", async () => {
    digiflazzMock.getPriceList.mockResolvedValueOnce([item("ml100", 15000)]).mockResolvedValueOnce([item("ml100", 16000)]);
    await getPriceListCached(CREDS, at(T0));
    const fresh = await getPriceListCached(CREDS, at(T0 + PRICE_LIST_CACHE_TTL_MS));
    expect(fresh[0]!.price.toString()).toBe("16000");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("never shares a cached list between different credentials", async () => {
    digiflazzMock.getPriceList.mockResolvedValueOnce([item("a")]).mockResolvedValueOnce([item("b")]);
    const a = await getPriceListCached(CREDS, at(T0));
    const b = await getPriceListCached({ username: CREDS.username, apiKey: "rotated-key" }, at(T0 + 1));
    expect(a[0]!.buyerSkuCode).toBe("a");
    expect(b[0]!.buyerSkuCode).toBe("b");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers (single flight)", async () => {
    let resolve!: (items: DigiflazzPriceListItem[]) => void;
    digiflazzMock.getPriceList.mockReturnValue(new Promise<DigiflazzPriceListItem[]>((r) => (resolve = r)));
    const p1 = getPriceListCached(CREDS, at(T0));
    const p2 = getPriceListCached(CREDS, at(T0 + 1));
    resolve([item("ml100")]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
  });

  it("does not cache an ordinary failure — the next request asks Digiflazz again", async () => {
    digiflazzMock.getPriceList.mockRejectedValueOnce(new DigiflazzSupplierError("Digiflazz price list HTTP 503")).mockResolvedValueOnce([item("ml100")]);
    await expect(getPriceListCached(CREDS, at(T0))).rejects.toThrow("HTTP 503");
    const list = await getPriceListCached(CREDS, at(T0 + 1));
    expect(list).toHaveLength(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("does not keep a fetcher's synchronous throw in flight — the next request asks Digiflazz again", async () => {
    digiflazzMock.getPriceList
      .mockImplementationOnce(() => {
        throw new DigiflazzSupplierError("Digiflazz price list HTTP 503");
      })
      .mockResolvedValueOnce([item("ml100")]);
    await expect(getPriceListCached(CREDS, at(T0))).rejects.toThrow("HTTP 503");
    const list = await getPriceListCached(CREDS, at(T0 + 1));
    expect(list).toHaveLength(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("after an rc 83 refusal, answers the same error without calling Digiflazz until the cooldown ends, then recovers", async () => {
    const refusal = rateLimited();
    digiflazzMock.getPriceList.mockRejectedValueOnce(refusal).mockResolvedValueOnce([item("ml100")]);
    await expect(getPriceListCached(CREDS, at(T0))).rejects.toBe(refusal);

    await expect(getPriceListCached(CREDS, at(T0 + RATE_LIMIT_COOLDOWN_MS - 1))).rejects.toBe(refusal);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);

    const list = await getPriceListCached(CREDS, at(T0 + RATE_LIMIT_COOLDOWN_MS));
    expect(list).toHaveLength(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("measures the rc 83 cooldown from when the refusal arrived, not from when the request started", async () => {
    const refusal = rateLimited();
    const SLOW = 20_000;
    let t = T0;
    digiflazzMock.getPriceList
      .mockImplementationOnce(async () => {
        t = T0 + SLOW; // Digiflazz took twenty seconds to say rc 83.
        throw refusal;
      })
      .mockResolvedValueOnce([item("ml100")]);
    await expect(getPriceListCached(CREDS, () => t)).rejects.toBe(refusal);

    await expect(getPriceListCached(CREDS, at(T0 + SLOW + RATE_LIMIT_COOLDOWN_MS - 1))).rejects.toBe(refusal);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);

    expect(await getPriceListCached(CREDS, at(T0 + SLOW + RATE_LIMIT_COOLDOWN_MS))).toHaveLength(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("drops expired lists and cooldowns of credentials nobody asks for any more", async () => {
    digiflazzMock.getPriceList.mockRejectedValueOnce(rateLimited()).mockResolvedValue([item("ml100")]);
    await expect(getPriceListCached({ username: "old", apiKey: "limited" }, at(T0))).rejects.toThrow("rc 83");
    await getPriceListCached({ username: "old", apiKey: "rotated-away" }, at(T0));
    expect(digiflazzPriceListCacheEntryCount()).toBe(2);

    await getPriceListCached(CREDS, at(T0 + PRICE_LIST_CACHE_TTL_MS));
    expect(digiflazzPriceListCacheEntryCount()).toBe(1);
  });

  it("uses a five-minute TTL and a sixty-second rate-limit cooldown", () => {
    expect(PRICE_LIST_CACHE_TTL_MS).toBe(5 * 60_000);
    expect(RATE_LIMIT_COOLDOWN_MS).toBe(60_000);
  });
});

describe("getPriceListFresh", () => {
  it("always asks Digiflazz, even with a cached list within its TTL", async () => {
    digiflazzMock.getPriceList.mockResolvedValueOnce([item("ml100", 15000)]).mockResolvedValueOnce([item("ml100", 16000)]);
    await getPriceListCached(CREDS, at(T0));
    const fresh = await getPriceListFresh(CREDS, at(T0 + 1));
    expect(fresh[0]!.price.toString()).toBe("16000");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("stores its list, so a cached read right after reuses it without another fetch", async () => {
    digiflazzMock.getPriceList.mockResolvedValue([item("ml100", 16000)]);
    await getPriceListFresh(CREDS, at(T0));
    const cached = await getPriceListCached(CREDS, at(T0 + 1));
    expect(cached[0]!.price.toString()).toBe("16000");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
  });

  it("refuses during an rc 83 cooldown with the same error, without asking Digiflazz", async () => {
    const refusal = rateLimited();
    digiflazzMock.getPriceList.mockRejectedValueOnce(refusal);
    await expect(getPriceListCached(CREDS, at(T0))).rejects.toBe(refusal);
    await expect(getPriceListFresh(CREDS, at(T0 + 1))).rejects.toBe(refusal);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
  });

  it("does not join an older in-flight fetch, and that older fetch finishing later does not overwrite the newer list", async () => {
    let resolveOld!: (items: DigiflazzPriceListItem[]) => void;
    digiflazzMock.getPriceList
      .mockReturnValueOnce(new Promise<DigiflazzPriceListItem[]>((r) => (resolveOld = r)))
      .mockResolvedValueOnce([item("ml100", 16000)]);
    const older = getPriceListCached(CREDS, at(T0));
    const fresh = await getPriceListFresh(CREDS, at(T0 + 1));
    expect(fresh[0]!.price.toString()).toBe("16000");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);

    resolveOld([item("ml100", 15000)]);
    expect((await older)[0]!.price.toString()).toBe("15000");
    const cached = await getPriceListCached(CREDS, at(T0 + 2));
    expect(cached[0]!.price.toString()).toBe("16000");
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });
});
