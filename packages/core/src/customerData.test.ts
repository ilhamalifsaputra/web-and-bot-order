import { describe, expect, it } from "vitest";
import { EncryptedCustomerDataError, parseCustomerData } from "./deliveryFields";

const ENVELOPE = JSON.stringify({ keyVersion: 1, iv: "aXY=", ciphertext: "Y3Q=", authTag: "dGFn" });

describe("parseCustomerData", () => {
  it("parses stored plaintext answers", () => {
    expect(parseCustomerData('[{"game_id":"12345","zone":"7"}]')).toEqual([{ game_id: "12345", zone: "7" }]);
  });

  it("returns [] for null, blank, invalid JSON and the wrong shape", () => {
    expect(parseCustomerData(null)).toEqual([]);
    expect(parseCustomerData("")).toEqual([]);
    expect(parseCustomerData("not json")).toEqual([]);
    expect(parseCustomerData('{"a":"b"}')).toEqual([]);
    expect(parseCustomerData('[1,2]')).toEqual([]);
  });

  it("throws EncryptedCustomerDataError for an encrypted envelope instead of returning []", () => {
    expect(() => parseCustomerData(ENVELOPE)).toThrow(EncryptedCustomerDataError);
  });

  it("does not mistake an ordinary object that lacks the envelope fields for an envelope", () => {
    expect(parseCustomerData(JSON.stringify({ keyVersion: 1, iv: "x" }))).toEqual([]);
  });
});
