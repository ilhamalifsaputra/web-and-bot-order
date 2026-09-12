import { describe, it, expect } from "vitest";
import { nicknameFieldMapping } from "./fieldMapping";
import { AdditionalFieldType, type AdditionalField } from "../deliveryFields";

function field(key: string): AdditionalField {
  return {
    key,
    label: { id: key, en: key },
    type: AdditionalFieldType.TEXT,
    required: true,
    options: [],
    placeholder: "",
  };
}

describe("nicknameFieldMapping", () => {
  it("returns null when the SKU has no additionalFields at all", () => {
    expect(nicknameFieldMapping([], false, false)).toBeNull();
    expect(nicknameFieldMapping([], true, true)).toBeNull();
  });

  it("1 field, no zone/server required: only targetKey is set", () => {
    expect(nicknameFieldMapping([field("user_id")], false, false)).toEqual({
      targetKey: "user_id",
      zoneKey: null,
      serverKey: null,
    });
  });

  it("2 fields + requiresZone: target+zone mapped, server stays null", () => {
    expect(nicknameFieldMapping([field("user_id"), field("zone_id")], true, false)).toEqual({
      targetKey: "user_id",
      zoneKey: "zone_id",
      serverKey: null,
    });
  });

  it("2 fields + requiresServer (no zone): server takes the SECOND field slot", () => {
    expect(nicknameFieldMapping([field("user_id"), field("server_id")], false, true)).toEqual({
      targetKey: "user_id",
      zoneKey: null,
      serverKey: "server_id",
    });
  });

  it("3 fields + both requiresZone and requiresServer: all three mapped in order", () => {
    expect(nicknameFieldMapping([field("user_id"), field("zone_id"), field("server_id")], true, true)).toEqual({
      targetKey: "user_id",
      zoneKey: "zone_id",
      serverKey: "server_id",
    });
  });

  it("fewer fields available than required flags demand: the flag's key stays null instead of crashing (requiresZone, only 1 field)", () => {
    expect(nicknameFieldMapping([field("user_id")], true, false)).toEqual({
      targetKey: "user_id",
      zoneKey: null,
      serverKey: null,
    });
  });

  it("fewer fields available than required flags demand: requiresZone AND requiresServer, only 2 fields — server has no slot left", () => {
    expect(nicknameFieldMapping([field("user_id"), field("zone_id")], true, true)).toEqual({
      targetKey: "user_id",
      zoneKey: "zone_id",
      serverKey: null,
    });
  });

  it("requiresServer only, but only 1 field available: serverKey stays null (nothing to over-index into)", () => {
    expect(nicknameFieldMapping([field("user_id")], false, true)).toEqual({
      targetKey: "user_id",
      zoneKey: null,
      serverKey: null,
    });
  });
});
