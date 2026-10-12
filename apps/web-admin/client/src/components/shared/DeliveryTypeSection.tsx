import { SettingsToggle } from "./SettingsToggle";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Ban, Hand, PlugZap, Zap, type LucideIcon } from "lucide-react";
import { useId, useRef } from "react";
import type { AdditionalFieldDraft } from "../../api/types";
import { AdditionalFieldsEditor } from "./AdditionalFieldsEditor";
import { AUTO_DELIVERY_FIELDS_TEMPLATE } from "./DeliveryTypeSection.helpers";

type DeliveryMethod = "auto" | "manual";
type AutoDeliverySourceOption = "none" | "digiflazz";

function methodOf(deliveryType: string): DeliveryMethod {
  return deliveryType === "auto" ? "auto" : "manual";
}

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
  isGame,
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
  isGame: boolean;
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
  const fieldId = useId();
  const method = methodOf(deliveryType);
  const requiresInfo = deliveryType === "manual_with_info";

  // Buyer-info fields follow the delivery type: leaving a type clears them
  // from the form (so a stock-delivered SKU never silently asks buyers for
  // input), but the cleared fields are kept here as an in-memory draft and
  // restored if the admin returns to the type they came from. The draft is
  // never submitted. It lives in this component, which stays mounted while
  // the method switches.
  const fieldsDraft = useRef<{ from: string; fields: AdditionalFieldDraft[] } | null>(null);

  function switchType(next: string) {
    if (next === deliveryType) return;
    if (additionalFields.length > 0) {
      fieldsDraft.current = { from: deliveryType, fields: additionalFields };
      onAdditionalFieldsChange([]);
    } else if (fieldsDraft.current?.from === next) {
      onAdditionalFieldsChange(fieldsDraft.current.fields);
      fieldsDraft.current = null;
    }
    onDeliveryTypeChange(next);
  }

  // Selecting Digiflazz pre-fills the buyer-info fields with the template
  // ONLY when the admin hasn't already added any — never overwrite fields
  // they've customized. Picking "None" just clears the source; any
  // already-typed Supplier SKU is left alone (it stops being submitted
  // once autoDeliverySource is cleared — see the parent pages' payload).
  function selectAutoDeliverySource(next: AutoDeliverySourceOption) {
    if (next === "digiflazz") {
      onAutoDeliverySourceChange("digiflazz");
      if (isGame && additionalFields.length === 0) {
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
    switchType(next === "auto" ? "auto" : "manual");
    onAutoDeliverySourceChange(null);
    onSupplierSkuChange("");
    onNicknameCheckGameCodeChange("");
    onProviderInputMappingChange?.("");
  }

  // Same "no hidden memory" reset as selectMethod above, for the other path
  // that can turn requiresInfo from true back to false: un-checking "Require
  // buyer information" in Step 2 without changing the Step 1 method.
  function selectBuyerInfo(next: "required" | "none") {
    switchType(next === "required" ? "manual_with_info" : "manual");
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
      <fieldset>
        <legend className="text-sm font-medium text-ink">
          Delivery Type <span className="text-rust">*</span>
        </legend>
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
      </fieldset>

      {/* Step 2 — whether the buyer must submit information first. A
          separate decision from the delivery method, only relevant once
          Manual is chosen. */}
      {method === "manual" && (
        <fieldset>
          <legend className="text-sm font-medium text-ink">Buyer Information</legend>
          <SettingsToggle
            id={`${fieldId}-requires-info`}
            label="Require buyer information"
            description={requiresInfo ? "Buyer must provide required information before checkout." : "Buyer pays first and waits for manual delivery."}
            checked={requiresInfo}
            onCheckedChange={(checked) => selectBuyerInfo(checked ? "required" : "none")}
          />
        </fieldset>
      )}

      {/* Step 3 — the fields themselves, only relevant once buyer info is required. */}
      {(requiresInfo || method === "auto") && (
        <fieldset>
          <legend className="text-sm font-medium text-ink">Buyer Information Fields</legend>
          <p className="mt-1 mb-2 text-xs text-ink-soft">
            {method === "auto"
              ? `Optional. Add fields only if this SKU needs input from the buyer (for example ${isGame ? "a Player ID" : "an account email"}); buyers fill them before paying.`
              : "The buyer fills these in before paying. At least one field is required."}
          </p>
          <AdditionalFieldsEditor isGame={isGame} value={additionalFields} onChange={onAdditionalFieldsChange} />
        </fieldset>
      )}

      {/* Step 4 — an optional supplier hookup, only relevant once buyer info
          is required (a supplier needs the Game ID / Server-Zone the buyer
          submits in Step 3 to fulfill automatically). */}
      <DeliveryTypeSectionAutoDeliverySourceNone requiresInfo={requiresInfo} autoDeliverySource={autoDeliverySource} selectAutoDeliverySource={selectAutoDeliverySource} fieldId={fieldId} isGame={isGame} supplierSku={supplierSku} onSupplierSkuChange={onSupplierSkuChange} />

      {/* Nickname check (Task 7) — an independent storefront + bot UX
          enhancement. Shown whenever the buyer submits an account field the
          check can run against: either Step 3's buyer-info fields
          (requiresInfo) or an Automatic-delivery product (method === "auto"),
          which is always eligible for catalog auto-detect from the product's
          Digiflazz brand regardless of whether an admin ever touches this
          field. NOT shown for plain Manual (no info) — that combination
          collects no buyer account field at all, so there's nothing for a
          live check to verify against. */}
      {isGame && (requiresInfo || method === "auto") && (
        <div>
          <label htmlFor={`${fieldId}-nickname-check-game-code-optional-2`} className="text-sm font-medium text-ink">Nickname check game code (optional)</label>
          <Input id={`${fieldId}-nickname-check-game-code-optional-2`}
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
      {isGame && onProviderInputMappingChange && (requiresInfo || method === "auto") && (
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

function DeliveryTypeSectionAutoDeliverySourceNone({ requiresInfo, autoDeliverySource, selectAutoDeliverySource, fieldId, isGame, supplierSku, onSupplierSkuChange }: {
  requiresInfo: boolean;
  autoDeliverySource: string | null;
  selectAutoDeliverySource: (next: AutoDeliverySourceOption) => void;
  fieldId: string;
  isGame: boolean;
  supplierSku: string;
  onSupplierSkuChange: (next: string) => void;
}) {
  return (requiresInfo && (
    <fieldset>
      <legend className="text-sm font-medium text-ink">Auto Delivery Source</legend>
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
          <label htmlFor={`${fieldId}-supplier-sku-1`} className="text-sm font-medium text-ink">
            Supplier SKU <span className="text-rust">*</span>
          </label>
          <Input id={`${fieldId}-supplier-sku-1`}
            className="mt-1"
            placeholder={isGame ? "e.g. mlbb86" : "Supplier SKU code"}
            value={supplierSku}
            onChange={(e) => onSupplierSkuChange(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">
            The Digiflazz buyer SKU code this denomination maps to.
          </p>
        </div>
      )}
    </fieldset>
  ));
}
