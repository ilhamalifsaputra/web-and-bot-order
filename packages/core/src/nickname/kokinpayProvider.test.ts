import { describe, it, expect, vi } from "vitest";
import { createKokinpayNicknameProvider } from "./kokinpayProvider";
import * as kokinpayModule from "../suppliers/kokinpay";

vi.mock("../suppliers/kokinpay");

describe("createKokinpayNicknameProvider", () => {
  it("returns valid nickname when checkGameNickname returns {valid:true, nickname}", async () => {
    const mockCheckGameNickname = vi.spyOn(kokinpayModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: true, nickname: "TestNickname" });

    const provider = createKokinpayNicknameProvider({ apiKey: "test-key" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
      server: "Asia",
    });

    expect(result).toEqual({ ok: true, nickname: "TestNickname" });
    expect(mockCheckGameNickname).toHaveBeenCalledWith(
      { apiKey: "test-key" },
      { gameCode: "ML", id: "123456", server: "Asia" }
    );
  });

  it("returns INVALID_TARGET when checkGameNickname returns {valid:false, nickname:null}", async () => {
    const mockCheckGameNickname = vi.spyOn(kokinpayModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: false, nickname: null });

    const provider = createKokinpayNicknameProvider({ apiKey: "test-key" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
      server: "Asia",
    });

    expect(result).toEqual({ ok: false, errorCode: "INVALID_TARGET" });
  });

  it("returns NETWORK_ERROR when checkGameNickname throws", async () => {
    const mockCheckGameNickname = vi.spyOn(kokinpayModule, "checkGameNickname");
    mockCheckGameNickname.mockRejectedValue(new Error("Network failure"));

    const provider = createKokinpayNicknameProvider({ apiKey: "test-key" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
    });

    expect(result).toEqual({ ok: false, errorCode: "NETWORK_ERROR" });
  });

  it("returns INVALID_TARGET when checkGameNickname returns {valid:true, nickname:null}", async () => {
    const mockCheckGameNickname = vi.spyOn(kokinpayModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: true, nickname: null });

    const provider = createKokinpayNicknameProvider({ apiKey: "test-key" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
    });

    expect(result).toEqual({ ok: false, errorCode: "INVALID_TARGET" });
  });

  it("has correct provider id", () => {
    const provider = createKokinpayNicknameProvider({ apiKey: "test-key" });
    expect(provider.id).toBe("kokinpay");
  });
});
