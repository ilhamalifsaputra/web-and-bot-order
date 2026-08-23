import { describe, it, expect, vi } from "vitest";
import { NicknameService } from "./service";
import type { NicknameProvider, NicknameLookupOutcome } from "./types";

function makeProvider(id: NicknameProvider["id"], impl: (req: unknown) => Promise<NicknameLookupOutcome>): NicknameProvider {
  return {
    id,
    checkNickname: vi.fn(impl),
  };
}

const REQ = { target: "123456789", zone: "1234" };

describe("NicknameService.checkNickname", () => {
  it("returns found on the first entry and never calls the second entry's provider", async () => {
    const providerA = makeProvider("kokinpay", async () => ({ ok: true, nickname: "ProPlayerA" }));
    const providerB = makeProvider("vipreseller", async () => ({ ok: true, nickname: "ProPlayerB" }));
    const service = new NicknameService([
      { provider: providerA, gameCode: "mobile-legends" },
      { provider: providerB, gameCode: "mobile-legends" },
    ]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "found", nickname: "ProPlayerA", providerId: "kokinpay" });
    expect(providerA.checkNickname).toHaveBeenCalledTimes(1);
    expect(providerB.checkNickname).not.toHaveBeenCalled();
  });

  it("falls through a retryable error on the first entry and finds the nickname on the second", async () => {
    const providerA = makeProvider("kokinpay", async () => ({ ok: false, errorCode: "NETWORK_ERROR" }));
    const providerB = makeProvider("vipreseller", async () => ({ ok: true, nickname: "ProPlayerB" }));
    const service = new NicknameService([
      { provider: providerA, gameCode: "mobile-legends" },
      { provider: providerB, gameCode: "mobile-legends" },
    ]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "found", nickname: "ProPlayerB", providerId: "vipreseller" });
    expect(providerA.checkNickname).toHaveBeenCalledTimes(1);
    expect(providerB.checkNickname).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on a non-retryable error and never calls the second entry", async () => {
    const providerA = makeProvider("kokinpay", async () => ({ ok: false, errorCode: "INVALID_TARGET" }));
    const providerB = makeProvider("vipreseller", async () => ({ ok: true, nickname: "ProPlayerB" }));
    const service = new NicknameService([
      { provider: providerA, gameCode: "mobile-legends" },
      { provider: providerB, gameCode: "mobile-legends" },
    ]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "not_found" });
    expect(providerA.checkNickname).toHaveBeenCalledTimes(1);
    expect(providerB.checkNickname).not.toHaveBeenCalled();
  });

  it("returns not_found after all entries are exhausted with retryable errors", async () => {
    const providerA = makeProvider("kokinpay", async () => ({ ok: false, errorCode: "TIMEOUT" }));
    const providerB = makeProvider("vipreseller", async () => ({ ok: false, errorCode: "RATE_LIMITED" }));
    const providerC = makeProvider("melostore", async () => ({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" }));
    const service = new NicknameService([
      { provider: providerA, gameCode: "mobile-legends" },
      { provider: providerB, gameCode: "mobile-legends" },
      { provider: providerC, gameCode: "mobile-legends" },
    ]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "not_found" });
    expect(providerA.checkNickname).toHaveBeenCalledTimes(1);
    expect(providerB.checkNickname).toHaveBeenCalledTimes(1);
    expect(providerC.checkNickname).toHaveBeenCalledTimes(1);
  });

  it("returns no_providers_configured when entries is empty", async () => {
    const service = new NicknameService([]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "no_providers_configured" });
  });

  it("tries entries in array order, not by provider id", async () => {
    const callOrder: string[] = [];
    const providerB = makeProvider("vipreseller", async () => {
      callOrder.push("vipreseller");
      return { ok: false, errorCode: "TIMEOUT" };
    });
    const providerA = makeProvider("kokinpay", async () => {
      callOrder.push("kokinpay");
      return { ok: true, nickname: "ProPlayerA" };
    });
    // Constructed with B first, A second.
    const service = new NicknameService([
      { provider: providerB, gameCode: "mobile-legends" },
      { provider: providerA, gameCode: "mobile-legends" },
    ]);

    const result = await service.checkNickname(REQ);

    expect(result).toEqual({ status: "found", nickname: "ProPlayerA", providerId: "kokinpay" });
    expect(callOrder).toEqual(["vipreseller", "kokinpay"]);
  });
});
