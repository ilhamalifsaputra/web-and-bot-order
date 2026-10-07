import { describe, expect, it } from "vitest";
import { checkoutInputConfiguration } from "./inputConfiguration";

const field = { key: "player_id", label: { id: "ID Pemain", en: "Player ID" }, type: "number", required: true };
const stock = { id: 1, additionalFields: null, providerInputMapping: null, autoDeliverySource: null };

describe("checkout input configuration", () => {
  it("keeps input-free stock delivery available", () => {
    expect(checkoutInputConfiguration(stock)).toEqual({ additional_fields: [], input_configuration_valid: true });
  });
  it.each(["not json", '[{"key":"bad"}]', JSON.stringify([field, field])])("fails closed on malformed metadata %s", (additionalFields) => {
    expect(checkoutInputConfiguration({ ...stock, additionalFields }).input_configuration_valid).toBe(false);
  });
  it("rejects unknown provider mapping keys without exposing mapping", () => {
    const result = checkoutInputConfiguration({ ...stock, additionalFields: JSON.stringify([field]), providerInputMapping: '{"digiflazz":{"keys":["missing"]}}' });
    expect(result).toEqual({ additional_fields: [], input_configuration_valid: false });
  });
  it.each([null, "[]"])("rejects input-free Digiflazz configuration %s", (additionalFields) => {
    expect(checkoutInputConfiguration({ ...stock, autoDeliverySource: "digiflazz", additionalFields }).input_configuration_valid).toBe(false);
  });
  it("parses existing constraints and provider references", () => {
    const result = checkoutInputConfiguration({ ...stock, additionalFields: JSON.stringify([{ ...field, minLength: 3 }]), providerInputMapping: '{"digiflazz":{"keys":["player_id"],"separator":""}}' });
    expect(result.input_configuration_valid).toBe(true);
    expect(result.additional_fields[0]).toMatchObject({ key: "player_id", minLength: 3, options: [], placeholder: "" });
  });
});
