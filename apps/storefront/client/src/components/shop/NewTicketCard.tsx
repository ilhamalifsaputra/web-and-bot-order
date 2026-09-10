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
 * five separate files: each composes the shared <FormField> + <Input> /
 * <Select> / <Textarea> primitives, plus (for the two text fields) a character
 * counter, so keeping them here keeps the controlled wiring readable in one
 * place. Their DOM/behaviour matches the task-14 brief.
 *
 * ### Why the counter is FormField's `hint` and the error keeps `role="alert"`
 * The counter goes through the `hint` slot rather than being rendered as a
 * loose sibling: that is the only way it lands *between* the control and the
 * error message (the original order) AND gets picked up by FormField's
 * `aria-describedby` merge, which is what the old hand-written
 * `aria-describedby="support-subject-counter"` did by hand.
 *
 * The error text is passed as a `<span role="alert">` rather than a bare
 * string. FormField's own error `<p>` has no live-region role, and dropping
 * the role would be a real regression on the *server*-error path: a 400 from
 * POST /api/v1/account/support/new sets `errors` without moving focus, so
 * nothing would announce it. (On the client-validation path focus does move to
 * the first invalid control, which now carries `aria-describedby` pointing at
 * the message — wiring the old markup did not have.)
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
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Input from "../ui/Input";
import Select from "../ui/Select";
import Textarea from "../ui/Textarea";
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

function OptionalSuffix() {
  return (
    <span className="font-normal normal-case text-ink-faint"> {t("web.support_field_optional")}</span>
  );
}

/** FormField's error `<p>` carries no live-region role; this keeps the
 * announcement the hand-rolled markup used to have — see the file header. */
function alertOf(message?: string | null): ReactNode {
  return message ? <span role="alert">{message}</span> : undefined;
}

/** The `x/max` character counter, shaped to sit inside FormField's hint `<p>`
 * (which supplies `mt-1 text-xs` and the describedby id) — hence `block
 * text-right` + the `ink-faint` colour override rather than its own wrapper. */
function counterHint(length: number, max: number): ReactNode {
  return (
    <span aria-live="polite" className="block text-right text-ink-faint">
      {length}/{max}
    </span>
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
    <FormField
      htmlFor="support-subject"
      label={t("web.support_field_subject")}
      required
      hint={counterHint(value.length, 100)}
      error={alertOf(error)}
    >
      <Input
        ref={inputRef}
        type="text"
        maxLength={100}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("web.support_field_subject_placeholder")}
      />
    </FormField>
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
    <FormField
      htmlFor="support-category"
      label={t("web.support_field_category")}
      required
      error={alertOf(error)}
    >
      <Select ref={selectRef} required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          {t("web.support_field_category_placeholder")}
        </option>
        {CATEGORY_VALUES.map((c) => (
          <option key={c} value={c}>
            {t(categoryLabelKey(c))}
          </option>
        ))}
      </Select>
    </FormField>
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
    <FormField
      htmlFor="support-product"
      label={t("web.support_field_product")}
      required
      error={alertOf(error)}
    >
      <Select ref={selectRef} required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          {t("web.support_field_product_placeholder")}
        </option>
        {products.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </Select>
    </FormField>
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
    <FormField
      htmlFor="support-order"
      label={
        <>
          {t("web.support_field_order")}
          <OptionalSuffix />
        </>
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("web.ticket_order_picker_none")}</option>
        {orders.map((o) => (
          <option key={o.code} value={o.code}>
            #{o.code} — {o.items}
          </option>
        ))}
      </Select>
    </FormField>
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
    <FormField
      htmlFor="support-description"
      label={t("web.support_field_description")}
      required
      hint={counterHint(value.length, 1000)}
      error={alertOf(error)}
    >
      <Textarea
        ref={textareaRef}
        className="min-h-[9rem] resize-y"
        maxLength={1000}
        rows={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("web.support_field_description_placeholder")}
      />
    </FormField>
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
    // Element-locked: this surface is a <form>, and the <Card> primitive
    // renders a <div>. The raw `.card card-pad` classes here are the sanctioned
    // usage for that case, not legacy debt — do NOT "fix" them into <Card>,
    // which would cost the form semantics. (`card-pad` replaced a hand-rolled
    // `p-6 sm:p-7` so the padding comes from the token-driven class the rest of
    // the page's surfaces use.)
    <form onSubmit={handleSubmit} noValidate className="card card-pad">
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
        <Button
          type="submit"
          variant="primary"
          fullWidth
          className="sm:w-auto"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {submitLabel}
        </Button>
      </div>

      {isSubmitting && value.files.length > 0 && (
        <div className="mt-3">
          <ProgressBar value={uploadProgress} />
        </div>
      )}
    </form>
  );
}
