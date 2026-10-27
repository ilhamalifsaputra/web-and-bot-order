import { describe, expect, it } from "vitest";
import { parseAdditionalFields, validateCustomerData, zAdditionalFields } from "./deliveryFields";
import { buildPlayerNicknameRequest, buildPlayerTarget, parseInputFields, inputConfigSnapshot, orderInputConfig, orderGameTargets, orderGameTargetLabels } from "./playerInput";

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

describe("orderGameTargetLabels", () => {
  const f = (key: string, id: string, en: string) => ({ key, label: { id, en }, type: "text", required: true });
  const cfg = (...fs: unknown[]) => ({ additionalFields: JSON.stringify(fs) });
  it("returns the configured label per role in the buyer's language, falling back to English", () => {
    const denom = cfg(f("uid", "ID Pemain", "Player ID"), f("zone", "Zona", "Zone"), f("server_id", "Server", "Server name"));
    expect(orderGameTargetLabels(denom, null, "id")).toEqual({ game_id: "ID Pemain", zone_id: "Zona", server_id: "Server" });
    expect(orderGameTargetLabels(denom, null, "en")).toEqual({ game_id: "Player ID", zone_id: "Zone", server_id: "Server name" });
    expect(orderGameTargetLabels(denom, null, "xx").game_id).toBe("Player ID");
  });
  it("leaves a role undefined when the field is missing or its label is blank", () => {
    const labels = orderGameTargetLabels(cfg(f("uid", "   ", " ")), null, "en");
    expect(labels).toEqual({ game_id: undefined, zone_id: undefined, server_id: undefined });
  });
  it("trims and caps very long labels", () => {
    const labels = orderGameTargetLabels(cfg(f("uid", " x ", ` ${"L".repeat(80)} `)), null, "en");
    expect(labels.game_id!.length).toBe(40);
    expect(labels.game_id!.endsWith("…")).toBe(true);
    expect(orderGameTargetLabels(cfg(f("uid", " x ", " y ")), null, "id").game_id).toBe("x");
  });
  it("resolves through the order snapshot and the explicit nickname mapping, and throws on a bad snapshot", () => {
    const abc = cfg(f("a", "A", "A-en"), f("b", "B", "B-en"), f("c", "C", "C-en"));
    const denom = { ...abc, providerInputMapping: JSON.stringify({ nickname: { targetKey: "c", zoneKey: "a" } }) };
    expect(orderGameTargetLabels({ additionalFields: "[]" }, inputConfigSnapshot(denom), "en")).toEqual({ game_id: "C-en", zone_id: "A-en", server_id: undefined });
    expect(() => orderGameTargetLabels(abc, "{bad", "en")).toThrow();
  });
});
