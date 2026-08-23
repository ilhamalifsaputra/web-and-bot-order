import { describe, it, expect, vi } from "vitest";
import { createMelostoreNicknameProvider } from "./melostoreProvider";
import * as melostoreModule from "../suppliers/melostore";

vi.mock("../suppliers/melostore");

describe("createMelostoreNicknameProvider", () => {
  it("returns valid nickname when checkGameNickname returns {valid:true, nickname}", async () => {
    const mockCheckGameNickname = vi.spyOn(melostoreModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: true, nickname: "TestNickname" });

    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
      server: "Asia",
    });

    expect(result).toEqual({ ok: true, nickname: "TestNickname" });
    expect(mockCheckGameNickname).toHaveBeenCalledWith(
      { apiKey: "test-key", secretKey: "test-secret" },
      { gameCode: "ML", id: "123456", server: "Asia" }
    );
  });

  it("returns INVALID_TARGET when checkGameNickname returns {valid:false, nickname:null, errorCode:4001}", async () => {
    const mockCheckGameNickname = vi.spyOn(melostoreModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: false, nickname: null, errorCode: 4001 });

    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
      server: "Asia",
    });

    expect(result).toEqual({ ok: false, errorCode: "INVALID_TARGET" });
  });

  it("returns INVALID_REQUEST when checkGameNickname returns {valid:false, nickname:null, errorCode:4006}", async () => {
    const mockCheckGameNickname = vi.spyOn(melostoreModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: false, nickname: null, errorCode: 4006 });

    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
      server: "Asia",
    });

    expect(result).toEqual({ ok: false, errorCode: "INVALID_REQUEST" });
  });

  it("returns NETWORK_ERROR when checkGameNickname throws", async () => {
    const mockCheckGameNickname = vi.spyOn(melostoreModule, "checkGameNickname");
    mockCheckGameNickname.mockRejectedValue(new Error("Network failure"));

    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
    });

    expect(result).toEqual({ ok: false, errorCode: "NETWORK_ERROR" });
  });

  it("returns INVALID_TARGET when checkGameNickname returns {valid:true, nickname:null} (edge case)", async () => {
    const mockCheckGameNickname = vi.spyOn(melostoreModule, "checkGameNickname");
    mockCheckGameNickname.mockResolvedValue({ valid: true, nickname: null });

    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    const result = await provider.checkNickname({
      gameCode: "ML",
      target: "123456",
    });

    expect(result).toEqual({ ok: false, errorCode: "INVALID_TARGET" });
  });

  it("has correct provider id", () => {
    const provider = createMelostoreNicknameProvider({ apiKey: "test-key", secretKey: "test-secret" });
    expect(provider.id).toBe("melostore");
  });
});
