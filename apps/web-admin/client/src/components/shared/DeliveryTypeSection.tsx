import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { AdditionalFieldsEditor } from "./AdditionalFieldsEditor";
import type { AdditionalFieldDraft } from "../../api/types";
import { Zap, Hand, FileText, Ban, PlugZap, type LucideIcon } from "lucide-react";

type DeliveryMethod = "auto" | "manual";
type AutoDeliverySourceOption = "none" | "digiflazz";

function methodOf(deliveryType: string): DeliveryMethod {
  return deliveryType === "auto" ? "auto" : "manual";
}

/** Pre-fill applied the first time an admin picks Digiflazz as the auto
 * delivery source, matching what Digiflazz-delivered games (Mobile Legends,
 * Free Fire, etc) actually need from the buyer. Only applied when
 * `additionalFields` is still empty — see `selectAutoDeliverySource` below —
 * so it never clobbers fields an admin already customized. */
const AUTO_DELIVERY_FIELDS_TEMPLATE: AdditionalFieldDraft[] = [
  { key: "user_id", labelId: "Game ID", labelEn: "Game ID", type: "text", required: true, optionsText: "", placeholder: "" },
];

function RadioOptionCard({
  id,
  value,
  title,
  description,
  icon: Icon,
}: {
  id: string;
  value: string;
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer transition-colors hover:border-pine/50 has-[[data-state=checked]]:border-pine has-[[data-state=checked]]:bg-pine-tint"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Icon className="h-4 w-4" />
          {title}
        </span>
        <span className="block text-xs text-ink-soft">{description}</span>
      </span>
    </label>
  );
}

/**
 * Delivery Type, split into three progressive-disclosure steps instead of
 * one three-way dropdown (Automatic / Manual / "Manual + Info" — the old
 * combined selector mixed the delivery method with a second, independent
 * decision about whether the buyer must submit information first, and
 * "Manual + Info" read as jargon to first-time sellers).
 *
 * The underlying data model is unchanged — still a single `deliveryType`
 * string ("auto" | "manual" | "manual_with_info") owned by the parent page,
 * same as before this refactor. This component only changes how that one
 * value is presented and edited: Step 1 picks "auto" vs "manual"; Step 2
 * (shown only once Manual is picked) picks manual_with_info vs plain manual;
 * Step 3 (shown only once buyer info is required) is the renamed field
 * editor. Keeping one source of truth means DenominationCreatePage/
 * EditPage's existing `canSubmit`/submit-payload logic (keyed off
 * `deliveryType === "manual_with_info"`) needed no changes.
 */
export function DeliveryTypeSection({
  deliveryType,
  onDeliveryTypeChange,
  additionalFields,
  onAdditionalFieldsChange,
  autoDeliverySource,
  onAutoDeliverySourceChange,
  supplierSku,
  onSupplierSkuChange,
  nicknameCheckGameCode,
  onNicknameCheckGameCodeChange,
  providerInputMapping = "",
  onProviderInputMappingChange,
}: {
  deliveryType: string;
  onDeliveryTypeChange: (next: string) => void;
  additionalFields: AdditionalFieldDraft[];
  onAdditionalFieldsChange: (next: AdditionalFieldDraft[]) => void;
  autoDeliverySource: string | null;
  onAutoDeliverySourceChange: (next: string | null) => void;
  supplierSku: string;
  onSupplierSkuChange: (next: string) => void;
  /** KokinPay's game_code for this denomination's title (Task 7) — an
   * independent, optional field: it offers the storefront's/bot's live
   * nickname-check UX for an Automatic-delivery product OR a manual_with_info
   * product that collects buyer-info fields — not just ones with a Digiflazz
   * auto-delivery link. Blank means auto-detect from this product's Digiflazz
   * brand (not "no live check"); fill it in only to override the detected
   * game, or to force a check for a product the catalog can't auto-detect. */
  nicknameCheckGameCode: string;
  onNicknameCheckGameCodeChange: (next: string) => void;
  providerInputMapping?: string;
  onProviderInputMappingChange?: (next: string) => void;
}) {
  const method = methodOf(deliveryType);
  const requiresInfo = deliveryType === "manual_with_info";

  // Selecting Digiflazz pre-fills the buyer-info fields with the template
  // ONLY when the admin hasn't already added any — never overwrite fields
  // they've customized. Picking "None" just clears the source; any
  // already-typed Supplier SKU is left alone (it stops being submitted
  // once autoDeliverySource is cleared — see the parent pages' payload).
  function selectAutoDeliverySource(next: AutoDeliverySourceOption) {
    if (next === "digiflazz") {
      onAutoDeliverySourceChange("digiflazz");
      if (additionalFields.length === 0) {
        onAdditionalFieldsChange(AUTO_DELIVERY_FIELDS_TEMPLATE);
      }
    } else {
      onAutoDeliverySourceChange(null);
    }
  }

  // No hidden memory across delivery methods, by design (UX principle: avoid
  // unnecessary state) — picking Manual always starts at Step 2's "No buyer
  // information required" default, same as a fresh row. `deliveryType` is
  // the single source of truth; there's nothing to restore once it's been
  // overwritten to "auto". Leaving Manual + buyer info required this way
  // also hides Step 4 and the nickname-check field, so their state is reset
  // too — otherwise a value like "digiflazz" or a stale game code would sit
  // unseen in the parent's state and could resurface silently if the admin
  // flips back to buyer info required later.
  function selectMethod(next: DeliveryMethod) {
    onDeliveryTypeChange(next === "auto" ? "auto" : "manual");
    onAutoDeliverySourceChange(null);
    onSupplierSkuChange("");
    onNicknameCheckGameCodeChange("");
    onProviderInputMappingChange?.("");
  }

  // Same "no hidden memory" reset as selectMethod above, for the other path
  // that can turn requiresInfo from true back to false: un-checking "Require
  // buyer information" in Step 2 without changing the Step 1 method.
  function selectBuyerInfo(next: "required" | "none") {
    onDeliveryTypeChange(next === "required" ? "manual_with_info" : "manual");
    if (next === "none") {
      onAutoDeliverySourceChange(null);
      onSupplierSkuChange("");
      onNicknameCheckGameCodeChange("");
      onProviderInputMappingChange?.("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Step 1 — how the product is delivered. */}
      <div>
        <label className="text-sm font-medium text-ink">
          Delivery Type <span className="text-rust">*</span>
        </label>
        <RadioGroup className="mt-2" value={method} onValueChange={(v) => selectMethod(v as DeliveryMethod)}>
          <RadioOptionCard
            id="delivery-method-auto"
            value="auto"
            title="Automatic Delivery"
            description="The product is delivered automatically after payment."
            icon={Zap}
          />
          <RadioOptionCard
            id="delivery-method-manual"
            value="manual"
            title="Manual Delivery"
            description="The seller manually delivers the product after payment."
            icon={Hand}
          />
        </RadioGroup>
      </div>

      {/* Step 2 — whether the buyer must submit information first. A
          separate decision from the delivery method, only relevant once
          Manual is chosen. */}
      {method === "manual" && (
        <div>
          <label className="text-sm font-medium text-ink">Buyer Information</label>
          <RadioGroup
            className="mt-2"
            value={requiresInfo ? "required" : "none"}
            onValueChange={(v) => selectBuyerInfo(v as "required" | "none")}
          >
            <RadioOptionCard
              id="buyer-info-none"
              value="none"
              title="No buyer information required"
              description="Buyer pays first and waits for manual delivery."
              icon={Hand}
            />
            <RadioOptionCard
              id="buyer-info-required"
              value="required"
              title="Require buyer information"
              description="Buyer must provide required information before checkout."
              icon={FileText}
            />
          </RadioGroup>
        </div>
      )}

      {/* Step 3 — the fields themselves, only relevant once buyer info is required. */}
      {(requiresInfo || method === "auto") && (
        <div>
          <label className="text-sm font-medium text-ink">Buyer Information Fields</label>
          <p className="mt-1 mb-2 text-xs text-ink-soft">
            The buyer fills configured fields before paying. Add only fields this SKU needs.
          </p>
          <AdditionalFieldsEditor value={additionalFields} onChange={onAdditionalFieldsChange} />
        </div>
      )}

      {/* Step 4 — an optional supplier hookup, only relevant once buyer info
          is required (a supplier needs the Game ID / Server-Zone the buyer
          submits in Step 3 to fulfill automatically). */}
      {requiresInfo && (
        <div>
          <label className="text-sm font-medium text-ink">Auto Delivery Source</label>
          <p className="mt-1 mb-2 text-xs text-ink-soft">
            Set this only if a supplier fulfills this denomination automatically after payment.
          </p>
          <RadioGroup
            className="mt-2"
            value={autoDeliverySource === "digiflazz" ? "digiflazz" : "none"}
            onValueChange={(v) => selectAutoDeliverySource(v as AutoDeliverySourceOption)}
          >
            <RadioOptionCard
              id="auto-delivery-source-none"
              value="none"
              title="None"
              description="No supplier is linked — delivery stays fully manual."
              icon={Ban}
            />
            <RadioOptionCard
              id="auto-delivery-source-digiflazz"
              value="digiflazz"
              title="Digiflazz"
              description="Matches this denomination to a Digiflazz price-list SKU."
              icon={PlugZap}
            />
          </RadioGroup>

          {autoDeliverySource === "digiflazz" && (
            <div className="mt-3">
              <label className="text-sm font-medium text-ink">
                Supplier SKU <span className="text-rust">*</span>
              </label>
              <Input
                className="mt-1"
                placeholder="e.g. mlbb86"
                value={supplierSku}
                onChange={(e) => onSupplierSkuChange(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-soft">
                The Digiflazz buyer SKU code this denomination maps to.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Nickname check (Task 7) — an independent storefront + bot UX
          enhancement. Shown whenever the buyer submits an account field the
          check can run against: either Step 3's buyer-info fields
          (requiresInfo) or an Automatic-delivery product (method === "auto"),
          which is always eligible for catalog auto-detect from the product's
          Digiflazz brand regardless of whether an admin ever touches this
          field. NOT shown for plain Manual (no info) — that combination
          collects no buyer account field at all, so there's nothing for a
          live check to verify against. */}
      {(requiresInfo || method === "auto") && (
        <div>
          <label className="text-sm font-medium text-ink">Nickname check game code (optional)</label>
          <Input
            className="mt-1"
            placeholder="e.g. mobile-legends"
            value={nicknameCheckGameCode}
            onChange={(e) => onNicknameCheckGameCodeChange(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">
            e.g. <code>mobile-legends</code>. Leave blank to disable nickname checking.
          </p>
        </div>
      )}
      {onProviderInputMappingChange && (requiresInfo || method === "auto") && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-ink">Advanced provider input mapping</summary>
          <label htmlFor="provider-input-mapping" className="mt-2 block text-sm text-ink-soft">Server mapping (JSON)</label>
          <textarea id="provider-input-mapping" className="mt-1 w-full rounded-lg border border-line bg-white p-3 font-mono text-sm" value={providerInputMapping} onChange={(e) => onProviderInputMappingChange(e.target.value)} rows={4} />
          <p className="mt-1 text-xs text-ink-soft">Optional. Map nickname target/zone/server keys and Digiflazz key order/separator. Referenced keys must exist in the buyer fields. Blank preserves the existing field order and space separator.</p>
        </details>
      )}
    </div>
  );
}
