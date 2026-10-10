import { describe, expect, it } from "vitest";
import { parseAdditionalFields, validateCustomerData, zAdditionalFields } from "./deliveryFields";
import { buildPlayerNicknameRequest, buildPlayerTarget, parseInputFields, inputConfigSnapshot, orderInputConfig, orderGameTargets } from "./playerInput";

const fields = parseAdditionalFields(JSON.stringify([
  { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "number", required: true, minLength: 4, maxLength: 20 },
  { key: "zone_id", label: { id: "Zone ID", en: "Zone ID" }, type: "number", required: true },
]));
describe("authoritative player inputs", () => {
  it("keeps a pending order target stable after catalog edits", () => {
    const original = { additionalFields: JSON.stringify(fields), providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } }) };
    const snapshot = inputConfigSnapshot(original);
    const resolved = orderInputConfig({ additionalFields: "[]" }, snapshot);
    expect(buildPlayerTarget(parseInputFields(resolved.additionalFields), resolved.providerInputMapping, { user_id: "000123", zone_id: "004" })).toBe("000123004");
  });
  it("preserves leading zeros and rejects short, long and missing zone answers", () => {
    expect(validateCustomerData(fields, [{ user_id: " 000123 ", zone_id: "004" }], 1)).toEqual([{ user_id: "000123", zone_id: "004" }]);
    for (const user_id of ["1", "1".repeat(21)]) expect(() => validateCustomerData(fields, [{ user_id, zone_id: "4" }], 1)).toThrow();
    for (const zone_id of [undefined, "", "   ", null]) expect(() => validateCustomerData(fields, [{ user_id: "1234", zone_id }], 1)).toThrow();
  });
  it("rejects injected keys and strips historical display-only nickname", () => {
    expect(() => validateCustomerData(fields, [{ user_id: "1234", zone_id: "4", admin: "true" }], 1)).toThrow();
    expect(validateCustomerData(fields, [{ user_id: "1234", zone_id: "4", nickname: "Bob" }], 1)).toEqual([{ user_id: "1234", zone_id: "4" }]);
  });
  it("validates optional values and authoritative select options", () => {
    const optional = { ...fields[1]!, required: false };
    expect(validateCustomerData([fields[0]!, optional], [{ user_id: "1234" }], 1)[0]?.zone_id).toBe("");
    expect(() => validateCustomerData([optional], [{ zone_id: "abc" }], 1)).toThrow();
    const select = { ...fields[0]!, type: "select" as const, options: ["asia", "europe"], minLength: undefined };
    expect(() => validateCustomerData([select], [{ user_id: "america" }], 1)).toThrow();
  });
  it("fails closed on corrupted stored configuration and unsafe pattern/key", () => {
    expect(() => parseInputFields("garbage")).toThrow();
    expect(zAdditionalFields.safeParse([{ ...fields[0], key: "__proto__" }]).success).toBe(false);
    expect(zAdditionalFields.safeParse([{ ...fields[0], pattern: "(a+)+$" }]).success).toBe(false);
  });
  it("maps only configured keys to the provider, preserving identifiers", () => {
    const mapping = JSON.stringify({ nickname: { targetKey: "user_id", zoneKey: "zone_id" }, digiflazz: { keys: ["user_id", "zone_id"], separator: "" } });
    const answers = { user_id: "000123", zone_id: "004" };
    expect(buildPlayerNicknameRequest(fields, mapping, answers)).toEqual({ target: "000123", zone: "004" });
    expect(buildPlayerTarget(fields, mapping, answers)).toBe("000123004");
    expect(() => buildPlayerTarget(fields, mapping, { user_id: "1234" })).toThrow();
    expect(() => buildPlayerTarget(fields, JSON.stringify({ digiflazz: { keys: ["callback_url"], separator: "" } }), answers)).toThrow();
  });
});

describe("orderGameTargets", () => {
  const mlbb = JSON.stringify([
    { key: "uid", label: { id: "UID", en: "UID" }, type: "text", required: true },
    { key: "zone", label: { id: "Zone", en: "Zone" }, type: "text", required: true },
    { key: "password", label: { id: "Sandi", en: "Password" }, type: "text", required: false },
  ]);
  it("reads only the mapped keys, one entry per unit, trimmed", () => {
    const targets = orderGameTargets({ additionalFields: mlbb }, null,
      JSON.stringify([{ uid: " 123 ", zone: "2201", password: "hunter2", email: "a@b.c" }, { uid: "456", zone: "" }]));
    expect(targets).toEqual([{ game_id: "123", zone_id: "2201" }, { game_id: "456" }]);
    expect(JSON.stringify(targets)).not.toMatch(/hunter2|a@b\.c/);
  });
  it("follows an explicit nickname mapping", () => {
    const abc = JSON.stringify(["a", "b", "c"].map((key) => ({ key, label: { id: key, en: key }, type: "text", required: true })));
    const targets = orderGameTargets({ additionalFields: abc, providerInputMapping: JSON.stringify({ nickname: { targetKey: "c", zoneKey: "a", serverKey: "b" } }) },
      null, JSON.stringify([{ a: "Z", b: "S", c: "T" }]));
    expect(targets).toEqual([{ game_id: "T", zone_id: "Z", server_id: "S" }]);
  });
  it("prefers the order's snapshot over a later catalog edit", () => {
    const snapshot = inputConfigSnapshot({ additionalFields: mlbb });
    expect(orderGameTargets({ additionalFields: "[]" }, snapshot, JSON.stringify([{ uid: "9", zone: "1" }]))).toEqual([{ game_id: "9", zone_id: "1" }]);
  });
  it("drops units with no mapped value and tolerates missing answers", () => {
    expect(orderGameTargets({ additionalFields: mlbb }, null, JSON.stringify([{ password: "x" }]))).toEqual([]);
    expect(orderGameTargets({ additionalFields: mlbb }, null, null)).toEqual([]);
    expect(orderGameTargets({ additionalFields: null }, null, JSON.stringify([{ target: "1" }]))).toEqual([{ game_id: "1" }]);
  });
  it("throws on a malformed snapshot so the caller can leave the details out", () => {
    expect(() => orderGameTargets({ additionalFields: mlbb }, "{bad", "[]")).toThrow();
  });
});
