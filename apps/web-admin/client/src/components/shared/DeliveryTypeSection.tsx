import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AdditionalFieldsEditor } from "./AdditionalFieldsEditor";
import type { AdditionalFieldDraft } from "../../api/types";
import { Zap, Hand, FileText, type LucideIcon } from "lucide-react";

type DeliveryMethod = "auto" | "manual";

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
  deliveryType,
  onDeliveryTypeChange,
  additionalFields,
  onAdditionalFieldsChange,
}: {
  deliveryType: string;
  onDeliveryTypeChange: (next: string) => void;
  additionalFields: AdditionalFieldDraft[];
  onAdditionalFieldsChange: (next: AdditionalFieldDraft[]) => void;
}) {
  const method = methodOf(deliveryType);
  const requiresInfo = deliveryType === "manual_with_info";

  // No hidden memory across delivery methods, by design (UX principle: avoid
  // unnecessary state) — picking Manual always starts at Step 2's "No buyer
  // information required" default, same as a fresh row. `deliveryType` is
  // the single source of truth; there's nothing to restore once it's been
  // overwritten to "auto".
  function selectMethod(next: DeliveryMethod) {
    onDeliveryTypeChange(next === "auto" ? "auto" : "manual");
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
            onValueChange={(v) => onDeliveryTypeChange(v === "required" ? "manual_with_info" : "manual")}
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
      {requiresInfo && (
        <div>
          <label className="text-sm font-medium text-ink">Buyer Information Fields</label>
          <p className="mt-1 mb-2 text-xs text-ink-soft">
            The buyer fills these in before paying. At least one field is required.
          </p>
          <AdditionalFieldsEditor value={additionalFields} onChange={onAdditionalFieldsChange} />
        </div>
      )}
    </div>
  );
}
