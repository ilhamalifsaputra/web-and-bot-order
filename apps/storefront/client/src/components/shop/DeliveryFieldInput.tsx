/**
 * One manual_with_info custom field's label + input (text/email/number/url or
 * a select dropdown) + inline validation error — the field-rendering unit
 * shared between CheckoutPage.tsx's info-collection step (Task 6),
 * InstantBuyPage.tsx's account-field card and OrderDetailPage.tsx's
 * PROCESSING-stage edit form (Task 10). Both contexts wrap this differently
 * (per-unit card during checkout vs. a single inline edit form on the
 * order-detail page), so only the field itself — not the per-unit grouping —
 * is extracted here.
 *
 * Design-system migration (Fase 7c, Task 11 carry-forward): the hand-rolled
 * `<label class="field-label">` + `<input class="field">` + `<p class="text-xs
 * text-rust">` trio is now composed from the `ui/` primitives — `<FormField>`
 * wires the label ↔ control id, the `aria-describedby`/`aria-invalid`
 * relationships and the error slot; `<Input>`/`<Select>` carry the `invalid`
 * (rust border) treatment. The `field`/`select` variant handling and the
 * `fieldError` validator wiring are unchanged.
 *
 * Validation (lib/deliveryFields.ts's fieldError) is a UX convenience only;
 * the server re-validates from scratch (validateCustomerData) before
 * persisting either at checkout or via the PATCH info route.
 */
import type { AdditionalField } from "../../api/types";
import { fieldError } from "../../lib/deliveryFields";
import { t, currentLang } from "../../lib/i18n";
import FormField from "../ui/FormField";
import Input from "../ui/Input";
import Select from "../ui/Select";

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
  const errorText = err ? t(err) : undefined;
  return (
    <FormField label={label} htmlFor={inputId} error={errorText} hint={field.helpText}>
      {field.type === "select" ? (
        <Select id={inputId} value={value} onChange={(e) => onChange(e.target.value)} required={field.required}>
          <option value="">{t("web.checkout_info_select_placeholder")}</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={inputId}
          type={
            field.type === "email" ? "email" : field.type === "url" ? "url" : "text"
          }
          // `type` alone gets the right keyboard on iOS Safari but not
          // reliably on Android, whose keyboards key off inputMode — so both
          // are declared rather than trusting the type to carry it.
          inputMode={
            field.type === "number" ? "numeric" : field.type === "email" ? "email" : field.type === "url" ? "url" : undefined
          }
          pattern={field.type === "number" ? "[0-9]*" : undefined}
          // A manual_with_info order routinely asks for the buyer's own email;
          // without this they retype an address the browser already knows.
          autoComplete={field.type === "email" ? "email" : undefined}
          value={value}
          required={field.required}
          minLength={field.minLength}
          maxLength={field.maxLength ?? 4096}
          placeholder={field.placeholder || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}
