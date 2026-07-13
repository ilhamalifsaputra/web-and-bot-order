/**
 * One manual_with_info custom field's label + input (text/email/number/url or
 * a select dropdown) + inline validation error — the field-rendering unit
 * shared between CheckoutPage.tsx's info-collection step (Task 6) and
 * OrderDetailPage.tsx's PROCESSING-stage edit form (Task 10). Both contexts
 * wrap this differently (per-unit card during checkout vs. a single inline
 * edit form on the order-detail page), so only the field itself — not the
 * per-unit grouping — is extracted here.
 *
 * Validation (lib/deliveryFields.ts's fieldError) is a UX convenience only;
 * the server re-validates from scratch (validateCustomerData) before
 * persisting either at checkout or via the PATCH info route.
 */
import type { AdditionalField } from "../../api/types";
import { fieldError } from "../../lib/deliveryFields";
import { t, currentLang } from "../../lib/i18n";

export default function DeliveryFieldInput({
  field,
  value,
  onChange,
  inputId,
}: {
  field: AdditionalField;
  value: string;
  onChange: (value: string) => void;
  inputId: string;
}) {
  const lang = currentLang();
  const label = lang === "id" ? field.label.id : field.label.en;
  // Only surface a validation error once the buyer has typed something — a
  // blank required field silently keeps the caller's submit disabled instead
  // of greeting them with red text.
  const err = value.trim() ? fieldError(field, value) : null;
  return (
    <div className="flex flex-col gap-1">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {field.type === "select" ? (
        <select id={inputId} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("web.checkout_info_select_placeholder")}</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type={
            field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "number" ? "number" : "text"
          }
          inputMode={field.type === "number" ? "numeric" : undefined}
          pattern={field.type === "number" ? "[0-9]*" : undefined}
          className="field"
          value={value}
          placeholder={field.placeholder || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {err && <p className="text-xs text-rust">{t(err)}</p>}
    </div>
  );
}
