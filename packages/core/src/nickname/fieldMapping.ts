import type { AdditionalField } from "../deliveryFields";

/**
 * Maps between a nickname-check wizard's collected {target, zone?, server?}
 * and the SKU's own admin-defined additionalFields, POSITIONALLY — there is
 * no reliable field-name convention to match against, since admins can freely
 * rename AUTO_DELIVERY_FIELDS_TEMPLATE's suggested keys
 * (DeliveryTypeSection.tsx). This mirrors the same "field order, not field
 * name" convention buildDigiflazzCustomerNo already relies on
 * (packages/db/src/crud/digiflazz.ts) — so once a nickname-check result is
 * written through this mapping, it round-trips correctly through that
 * function regardless of which flow (bot customerInfo, storefront checkout
 * form, or this wizard) originally produced it.
 *
 * fields[0] always maps to `target`. If `requiresZone`, the NEXT field maps
 * to `zone`. If `requiresServer`, the field after THAT (i.e. after zone, if
 * zone was also required) maps to `server`. Returns null when the SKU has no
 * additionalFields defined at all — there is no schema to map into; callers
 * should fall back to their own pre-existing behavior for that edge case.
 */
export function nicknameFieldMapping(
  fields: AdditionalField[],
  requiresZone: boolean,
  requiresServer: boolean,
): { targetKey: string; zoneKey: string | null; serverKey: string | null } | null {
  if (fields.length === 0) return null;
  let idx = 1;
  const targetKey = fields[0]!.key;
  const zoneKey = requiresZone && fields[idx] ? fields[idx++]!.key : null;
  const serverKey = requiresServer && fields[idx] ? fields[idx]!.key : null;
  return { targetKey, zoneKey, serverKey };
}
