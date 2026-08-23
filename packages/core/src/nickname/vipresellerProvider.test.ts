import { describe, it, expect, vi, afterEach } from "vitest";
import { createVipResellerNicknameProvider } from "./vipresellerProvider";
import * as vipreseller from "../suppliers/vipreseller";

const CREDS = { apiId: "vr-id-123", apiKey: "vr-s3cr3t-key" };

describe("createVipResellerNicknameProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has id 'vipreseller'", () => {
    const provider = createVipResellerNicknameProvider(CREDS);
    expect(provider.id).toBe("vipreseller");
  });

  it("returns {ok:true, nickname} when the underlying lookup finds a nickname", async () => {
    vi.spyOn(vipreseller, "checkNicknameViaVipReseller").mockResolvedValue({ nickname: "ProPlayer123" });
    const provider = createVipResellerNicknameProvider(CREDS);
    const result = await provider.checkNickname({ gameCode: "mobile-legends", target: "123456789", server: "1234" });
    expect(result).toEqual({ ok: true, nickname: "ProPlayer123" });
  });

  it("returns {ok:false, errorCode:'INVALID_TARGET'} when the underlying lookup finds no nickname", async () => {
    vi.spyOn(vipreseller, "checkNicknameViaVipReseller").mockResolvedValue({ nickname: null });
    const provider = createVipResellerNicknameProvider(CREDS);
    const result = await provider.checkNickname({ gameCode: "mobile-legends", target: "0" });
    expect(result).toEqual({ ok: false, errorCode: "INVALID_TARGET" });
  });

  it("returns {ok:false, errorCode:'NETWORK_ERROR'} when the underlying lookup throws", async () => {
    vi.spyOn(vipreseller, "checkNicknameViaVipReseller").mockRejectedValue(
      new Error(`VIP-Reseller game-feature HTTP 502`),
    );
    const provider = createVipResellerNicknameProvider(CREDS);
    const result = await provider.checkNickname({ gameCode: "mobile-legends", target: "1" });
    expect(result).toEqual({ ok: false, errorCode: "NETWORK_ERROR" });
  });

  it("passes gameCode/target/server through to the underlying lookup", async () => {
    const spy = vi.spyOn(vipreseller, "checkNicknameViaVipReseller").mockResolvedValue({ nickname: "X" });
    const provider = createVipResellerNicknameProvider(CREDS);
    await provider.checkNickname({ gameCode: "mobile-legends", target: "123456789", server: "1234" });
    expect(spy).toHaveBeenCalledWith(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
  });
});
