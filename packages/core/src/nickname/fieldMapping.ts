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

/**
 * Build the final customerData unit for one nickname-check result, keyed
 * through the SKU's own additionalFields (positionally, via
 * nicknameFieldMapping) instead of the old hardcoded {target,zone,server}
 * shape — see this file's header comment for why field ORDER, not field
 * NAME, is the only reliable convention here. Falls back to the legacy
 * {target,zone,server} keys when the SKU has no additionalFields at all
 * (mapping is null) — there's no schema to map into, so nothing is lost by
 * keeping the old shape for that edge case.
 *
 * Shared between apps/order-bot/src/conversations/nicknameCheck.ts (the real
 * production caller) and the money-critical round-trip test in
 * packages/db/src/crud/digiflazz.test.ts (final-review round 3 dedup — that
 * test used to carry its own inlined copy of this exact logic, which meant it
 * only proved the mapping *pattern* round-trips, not that the actually
 * shipped implementation does).
 */
export function buildCustomerDataUnit(
  fields: AdditionalField[],
  requiresZone: boolean,
  requiresServer: boolean,
  answer: { target: string; zone?: string; server?: string; nickname?: string },
): Record<string, string> {
  const mapping = nicknameFieldMapping(fields, requiresZone, requiresServer);
  const unit: Record<string, string> = mapping
    ? {
        [mapping.targetKey]: answer.target,
        ...(mapping.zoneKey && answer.zone ? { [mapping.zoneKey]: answer.zone } : {}),
        ...(mapping.serverKey && answer.server ? { [mapping.serverKey]: answer.server } : {}),
      }
    : { target: answer.target, ...(answer.zone ? { zone: answer.zone } : {}), ...(answer.server ? { server: answer.server } : {}) };
  // Preserve the found nickname for display purposes — never consumed by
  // buildDigiflazzCustomerNo/computeAccountDiagnosticNote (they only read
  // known field keys), purely for whatever UI currently shows it.
  if (answer.nickname) unit.nickname = answer.nickname;
  return unit;
}
