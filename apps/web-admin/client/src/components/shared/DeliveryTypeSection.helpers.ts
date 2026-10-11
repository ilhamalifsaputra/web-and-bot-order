import type { AdditionalFieldDraft } from "../../api/types";

/** Pre-fill applied the first time an admin picks Digiflazz as the auto
 * delivery source, matching what Digiflazz-delivered games (Mobile Legends,
 * Free Fire, etc) actually need from the buyer. Only applied when
 * `additionalFields` is still empty — see `selectAutoDeliverySource` below —
 * so it never clobbers fields an admin already customized. */
export const AUTO_DELIVERY_FIELDS_TEMPLATE: AdditionalFieldDraft[] = [
  { key: "user_id", labelId: "Game ID", labelEn: "Game ID", type: "text", required: true, optionsText: "", placeholder: "" },
];
