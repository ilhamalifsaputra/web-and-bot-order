/**
 * Left-column "Create a new ticket" card of the /help page.
 *
 * Fully controlled: the parent (HelpPage, a later task) owns every field
 * value, the product/order option lists, the submit mutation and its
 * `isSubmitting` / `uploadProgress` flags, and any server-side field errors.
 * This card only renders the form, runs a pre-submit client-validation pass,
 * and calls `onSubmit()` when that pass is clean.
 *
 * The five field controls are small internal function components rather than
 * five separate files: each is a thin wrapper over a `.field` input/select
 * plus (for the two text fields) a character counter, so keeping them here
 * keeps the controlled wiring readable in one place. Their DOM/behaviour
 * matches the task-14 brief.
 *
 * The nine TicketCategory values are mirrored locally (CATEGORY_VALUES)
 * rather than imported from `@app/core/enums`: neither React SPA in this repo
 * takes `@app/core` as a runtime dependency (see api/types.ts's
 * AdditionalField note and lib/deliveryFields.ts), and only the bare string
 * values are needed to build the <option> list. The label for each comes
 * from `web.support_category_<lowercased value>`.
 */
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Send, SquarePen } from "lucide-react";
import { t } from "../../lib/i18n";
import Spinner from "./Spinner";
import ProgressBar from "./ProgressBar";
import EvidenceUploader from "./EvidenceUploader";
import DataSafetyNotice from "./DataSafetyNotice";

/** Mirrors packages/core/src/enums.ts's TicketCategory — see file header. */
const CATEGORY_VALUES = [
  "ORDER",
  "PAYMENT",
  "ACCOUNT",
  "PRODUCT",
  "OTHER",
  "DELIVERY",
  "GAME_TOPUP",
  "REFUND",
  "TECHNICAL",
] as const;

const categoryLabelKey = (value: string): string => `web.support_category_${value.toLowerCase()}`;

type FieldName = "subject" | "category" | "product" | "description";

export interface NewTicketFormValue {
  subject: string;
  category: string; // "" | a TicketCategory value
  productId: string; // "" | product id as string
  orderCode: string; // "" | an order code
  description: string;
  files: File[];
}

export interface NewTicketCardProps {
  value: NewTicketFormValue;
  /** Parent merges the patch into its own state. */
  onChange: (patch: Partial<NewTicketFormValue>) => void;
  products: { id: number; name: string }[];
  orders: { code: string; items: string }[];
  /**
   * Field-name -> resolved error string, set by the parent after a failed
   * submit (server 400). Takes precedence over this card's own pre-submit
   * client-validation messages.
   */
  errors: Partial<Record<FieldName, string>>;
  /** Parent runs the mutation; only called when client validation passes. */
  onSubmit: () => void;
  isSubmitting: boolean;
  /** 0..100; parent updates during the attachment upload. */
  uploadProgress: number;
}

const REQUIRED_MARK = (
  <span aria-hidden="true" className="text-rust">
    {" "}
    *
  </span>
);

function OptionalSuffix() {
  return (
    <span className="font-normal normal-case text-ink-faint"> {t("web.support_field_optional")}</span>
  );
}

function InlineError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-rust">
      {message}
    </p>
  );
}

function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  return (
    <div className="mt-1 text-right">
      <span id={id} aria-live="polite" className="text-xs text-ink-faint">
        {length}/{max}
      </span>
    </div>
  );
}

function SubjectField({
  value,
  onChange,
  error,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  inputRef: RefObject<HTMLInputElement>;
}) {
  return (
    <div>
      <label className="field-label" htmlFor="support-subject">
        {t("web.support_field_subject")}
        {REQUIRED_MARK}
      </label>
      <input
        id="support-subject"
        ref={inputRef}
        type="text"
        className="field"
        maxLength={100}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("web.support_field_subject_placeholder")}
        aria-describedby="support-subject-counter"
        aria-invalid={error ? true : undefined}
      />
      <Counter id="support-subject-counter" length={value.length} max={100} />
      <InlineError message={error} />
    </div>
  );
}

function CategorySelect({
  value,
  onChange,
  error,
  selectRef,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  selectRef: RefObject<HTMLSelectElement>;
}) {
  return (
    <div>
      <label className="field-label" htmlFor="support-category">
        {t("web.support_field_category")}
        {REQUIRED_MARK}
      </label>
      <select
        id="support-category"
        ref={selectRef}
        className="field"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      >
        <option value="" disabled>
          {t("web.support_field_category_placeholder")}
        </option>
        {CATEGORY_VALUES.map((c) => (
          <option key={c} value={c}>
            {t(categoryLabelKey(c))}
          </option>
        ))}
      </select>
      <InlineError message={error} />
    </div>
  );
}

function ProductSelect({
  value,
  onChange,
  products,
  error,
  selectRef,
}: {
  value: string;
  onChange: (v: string) => void;
  products: { id: number; name: string }[];
  error?: string | null;
  selectRef: RefObject<HTMLSelectElement>;
}) {
  return (
    <div>
      <label className="field-label" htmlFor="support-product">
        {t("web.support_field_product")}
        {REQUIRED_MARK}
      </label>
      <select
        id="support-product"
        ref={selectRef}
        className="field"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      >
        <option value="" disabled>
          {t("web.support_field_product_placeholder")}
        </option>
        {products.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </select>
      <InlineError message={error} />
    </div>
  );
}

function OrderSelect({
  value,
  onChange,
  orders,
}: {
  value: string;
  onChange: (v: string) => void;
  orders: { code: string; items: string }[];
}) {
  return (
    <div>
      <label className="field-label" htmlFor="support-order">
        {t("web.support_field_order")}
        <OptionalSuffix />
      </label>
      <select
        id="support-order"
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("web.ticket_order_picker_none")}</option>
        {orders.map((o) => (
          <option key={o.code} value={o.code}>
            #{o.code} — {o.items}
          </option>
        ))}
      </select>
    </div>
  );
}

function DescriptionField({
  value,
  onChange,
  error,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  textareaRef: RefObject<HTMLTextAreaElement>;
}) {
  return (
    <div>
      <label className="field-label" htmlFor="support-description">
        {t("web.support_field_description")}
        {REQUIRED_MARK}
      </label>
      <textarea
        id="support-description"
        ref={textareaRef}
        className="field min-h-[9rem] resize-y"
        maxLength={1000}
        rows={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("web.support_field_description_placeholder")}
        aria-describedby="support-description-counter"
        aria-invalid={error ? true : undefined}
      />
      <Counter id="support-description-counter" length={value.length} max={1000} />
      <InlineError message={error} />
    </div>
  );
}

export default function NewTicketCard({
  value,
  onChange,
  products,
  orders,
  errors,
  onSubmit,
  isSubmitting,
  uploadProgress,
}: NewTicketCardProps) {
  // Pre-submit validation lives here so the messages can show without a
  // server round-trip; the parent's `errors` prop (server 400s) takes
  // precedence over it, field by field.
  const [clientErrors, setClientErrors] = useState<Partial<Record<FieldName, string>>>({});

  const subjectRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const productRef = useRef<HTMLSelectElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const errorFor = (field: FieldName): string | undefined => errors[field] ?? clientErrors[field];

  function validate(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    const subject = value.subject.trim();
    if (subject.length < 1 || subject.length > 100) found.subject = t("web.support_err_subject");
    if (!value.category) found.category = t("web.support_err_category");
    if (!value.productId) found.product = t("web.support_err_product");
    if (value.description.trim().length < 1) found.description = t("web.support_err_description");
    return found;
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const found = validate();
    setClientErrors(found);

    const focusOrder: [FieldName, RefObject<HTMLElement>][] = [
      ["subject", subjectRef],
      ["category", categoryRef],
      ["product", productRef],
      ["description", descriptionRef],
    ];
    const firstInvalid = focusOrder.find(([field]) => found[field]);
    if (firstInvalid) {
      firstInvalid[1].current?.focus();
      return;
    }
    onSubmit();
  }

  const submitLabel: ReactNode = isSubmitting ? (
    <>
      <Spinner /> {t("web.support_sending")}
    </>
  ) : (
    <>
      <Send className="w-4 h-4" aria-hidden="true" /> {t("web.support_send_ticket")}
    </>
  );

  return (
    <form onSubmit={handleSubmit} noValidate className="card p-6 sm:p-7">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-pine-tint text-pine">
          <SquarePen className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-lg text-ink">{t("web.support_create_title")}</h2>
          <p className="text-sm text-ink-soft">{t("web.support_create_subtitle")}</p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <SubjectField
          value={value.subject}
          onChange={(v) => onChange({ subject: v })}
          error={errorFor("subject")}
          inputRef={subjectRef}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CategorySelect
            value={value.category}
            onChange={(v) => onChange({ category: v })}
            error={errorFor("category")}
            selectRef={categoryRef}
          />
          <ProductSelect
            value={value.productId}
            onChange={(v) => onChange({ productId: v })}
            products={products}
            error={errorFor("product")}
            selectRef={productRef}
          />
        </div>

        <OrderSelect
          value={value.orderCode}
          onChange={(v) => onChange({ orderCode: v })}
          orders={orders}
        />

        <DescriptionField
          value={value.description}
          onChange={(v) => onChange({ description: v })}
          error={errorFor("description")}
          textareaRef={descriptionRef}
        />

        <div>
          <div className="field-label">
            {t("web.support_attach")}
            <OptionalSuffix />
          </div>
          <EvidenceUploader
            files={value.files}
            onChange={(files) => onChange({ files })}
            disabled={isSubmitting}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <DataSafetyNotice />
        <button
          type="submit"
          className="btn btn-primary w-full sm:w-auto"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {submitLabel}
        </button>
      </div>

      {isSubmitting && value.files.length > 0 && (
        <div className="mt-3">
          <ProgressBar value={uploadProgress} />
        </div>
      )}
    </form>
  );
}
