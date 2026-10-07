import { parseInputFields, parseProviderInputMapping } from "@app/core/playerInput";
import { logger } from "@app/core/logger";
import type { AdditionalField } from "@app/core/deliveryFields";

/** Public fields and a safe validity flag; provider mappings stay on the server. */
export function checkoutInputConfiguration(denom: {
  id: number;
  additionalFields: string | null;
  providerInputMapping?: string | null;
  autoDeliverySource: string | null;
}): { additional_fields: AdditionalField[]; input_configuration_valid: boolean } {
  let reason = "invalid_field_metadata";
  try {
    const fields = parseInputFields(denom.additionalFields);
    reason = "invalid_provider_mapping";
    parseProviderInputMapping(denom.providerInputMapping, fields);
    reason = "missing_digiflazz_inputs";
    if (denom.autoDeliverySource === "digiflazz" && fields.length === 0) throw new Error(reason);
    return { additional_fields: fields, input_configuration_valid: true };
  } catch {
    // Never log metadata, customer answers, mappings or supplier credentials.
    logger.warn({ denominationId: denom.id, reason }, "Invalid checkout input configuration");
    return { additional_fields: [], input_configuration_valid: false };
  }
}
