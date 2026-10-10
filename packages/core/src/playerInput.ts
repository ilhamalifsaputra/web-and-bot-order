import { z } from "zod";
import { zAdditionalFields, validateCustomerData, parseAdditionalFields, parseCustomerData, type AdditionalField } from "./deliveryFields";
import { ValidationError } from "./errors";

/** Input requirements and provider mappings are separate, server-owned data. */
export const zProviderInputMapping = z.object({
  nickname: z.object({ targetKey: z.string(), zoneKey: z.string().optional(), serverKey: z.string().optional() }).strict().optional(),
  digiflazz: z.object({ keys: z.array(z.string()).min(1).max(32), separator: z.enum(["", " ", "|", ",", ":"]).default(" ") }).strict().optional(),
}).strict();
export type ProviderInputMapping = z.infer<typeof zProviderInputMapping>;

export function parseInputFields(raw: string | null | undefined): AdditionalField[] {
  if (!raw) return [];
  try { return zAdditionalFields.parse(JSON.parse(raw)); }
  catch { throw new ValidationError("error.input_config_invalid"); }
}

export function parseProviderInputMapping(raw: string | null | undefined, fields: AdditionalField[]): ProviderInputMapping {
  if (!raw) return {};
  try {
    const mapping = zProviderInputMapping.parse(JSON.parse(raw));
    const keys = new Set(fields.map((f) => f.key));
    const refs = [...(mapping.digiflazz?.keys ?? []), ...Object.values(mapping.nickname ?? {})];
    if (refs.some((key) => !keys.has(key))) throw new Error("unknown mapping key");
    if (mapping.digiflazz && new Set(mapping.digiflazz.keys).size !== mapping.digiflazz.keys.length) throw new Error("duplicate target key");
    return mapping;
  } catch { throw new ValidationError("error.input_config_invalid"); }
}

/** Compatibility default for existing admin-defined keys. New mappings can
 * explicitly choose any field; clients never need provider parameter names. */
export function nicknameInputKeys(fields: AdditionalField[], raw?: string | null) {
  const explicit = parseProviderInputMapping(raw, fields).nickname;
  if (explicit) return explicit;
  const has = (key: string) => fields.some((f) => f.key === key);
  return {
    targetKey: fields[0]?.key ?? "target",
    ...(has("zone_id") ? { zoneKey: "zone_id" } : has("zone") ? { zoneKey: "zone" } : {}),
    ...(has("server_id") ? { serverKey: "server_id" } : has("server") ? { serverKey: "server" } : {}),
  };
}

export function buildPlayerNicknameRequest(fields: AdditionalField[], raw: string | null | undefined, answers: unknown) {
  const unit = validateCustomerData(fields, [answers], 1)[0];
  if (!unit || fields.length === 0) throw new ValidationError("error.input_config_invalid");
  const keys = nicknameInputKeys(fields, raw);
  const target = unit[keys.targetKey];
  if (!target) throw new ValidationError("error.field_required", { key: keys.targetKey });
  return { target, ...(keys.zoneKey && unit[keys.zoneKey] ? { zone: unit[keys.zoneKey] } : {}), ...(keys.serverKey && unit[keys.serverKey] ? { server: unit[keys.serverKey] } : {}) };
}

export function buildPlayerTarget(fields: AdditionalField[], raw: string | null | undefined, answers: unknown): string {
  const unit = validateCustomerData(fields, [answers], 1)[0];
  if (!unit || fields.length === 0) throw new ValidationError("error.input_config_invalid");
  const mapping = parseProviderInputMapping(raw, fields).digiflazz;
  return (mapping?.keys ?? fields.map((f) => f.key)).map((key) => unit[key]).filter(Boolean).join(mapping?.separator ?? " ");
}

export function inputConfigSnapshot(denom: { additionalFields: string | null; providerInputMapping?: string | null }): string {
  const fields = parseInputFields(denom.additionalFields);
  parseProviderInputMapping(denom.providerInputMapping, fields);
  return JSON.stringify({ fields, providerInputMapping: denom.providerInputMapping ?? null });
}

/** Historical orders have no snapshot; new ones must never silently fall back
 * when their snapshot is malformed. */
export function orderInputConfig(denom: { additionalFields: string | null; providerInputMapping?: string | null }, snapshot?: string | null) {
  if (!snapshot) return denom;
  try {
    const parsed = z.object({ fields: zAdditionalFields, providerInputMapping: z.string().nullable() }).parse(JSON.parse(snapshot));
    parseProviderInputMapping(parsed.providerInputMapping, parsed.fields);
    return { additionalFields: JSON.stringify(parsed.fields), providerInputMapping: parsed.providerInputMapping };
  } catch { throw new ValidationError("error.input_config_invalid"); }
}

/** The Game ID / Zone / Server a buyer typed for one unit of a game top-up. */
export type GameTarget = { game_id?: string; zone_id?: string; server_id?: string };

/** Game ID / Zone / Server per unit of an order, read ONLY through the
 * denomination's input mapping (the order's snapshot first), so no other
 * answer, such as an e-mail or password, can ever leave through it. Values are
 * trimmed; an empty one is left out, and so is a unit with none. Throws
 * ValidationError on a malformed saved configuration — the caller leaves the
 * details out. Shared by the Telegram receipt and the storefront. */
export function orderGameTargets(
  denom: { additionalFields: string | null; providerInputMapping?: string | null },
  snapshot: string | null | undefined,
  customerData: string | null | undefined,
): GameTarget[] {
  const config = orderInputConfig(denom, snapshot);
  const keys: { targetKey: string; zoneKey?: string; serverKey?: string } = nicknameInputKeys(parseAdditionalFields(config.additionalFields), config.providerInputMapping);
  const targets: GameTarget[] = [];
  for (const unit of parseCustomerData(customerData)) {
    const target: GameTarget = {};
    for (const [name, key] of [["game_id", keys.targetKey], ["zone_id", keys.zoneKey], ["server_id", keys.serverKey]] as const) {
      const value = (key ? unit[key] : undefined)?.trim();
      if (value) target[name] = value;
    }
    if (Object.keys(target).length) targets.push(target);
  }
  return targets;
}
