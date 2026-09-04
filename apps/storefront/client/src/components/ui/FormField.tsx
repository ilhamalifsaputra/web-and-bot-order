/**
 * FormField — the label + control + hint/error composition that pages use.
 * <Input>/<Select>/<Textarea> stay dumb; this wires the a11y relationships:
 *
 *   - `<Label htmlFor>` ↔ control `id` (generated with `useId` when the
 *     caller passes neither `htmlFor` nor `id`).
 *   - `aria-describedby` on the control = hint id + error id (whichever
 *     exist), merged with any `aria-describedby` the caller already set.
 *   - when `error` is set: `aria-invalid` on the control, and — for a control
 *     that is a component (not a raw DOM tag) — the `invalid` prop, so our
 *     field primitives also get the `rust` border.
 *
 * ### aria-wiring approach: `cloneElement`
 * Chosen over a render-prop. The control is passed as a single JSX child, so
 * `cloneElement` lets callers write the natural
 * `<FormField label="…"><Input name="email" /></FormField>` with zero
 * boilerplate, and FormField injects `id` / `aria-*` / `invalid` without the
 * caller threading ids by hand. A render-prop (`{(props) => <Input {...props}/>}`)
 * would push that wiring back onto every call site for no gain here — there is
 * only ever one control and it always wants the same four props. The repo has
 * no prior FormField, so no convention is being broken.
 * `cloneElement` merges: an explicit prop the caller set on the child always
 * wins over FormField's injected value.
 */
import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import Label from "./Label";
import { cn } from "./cn";

export interface FormFieldProps {
  label: ReactNode;
  /** The single form control — <Input>, <Select>, <Textarea>, <Checkbox>… */
  children: ReactElement<Record<string, unknown>>;
  hint?: ReactNode;
  error?: ReactNode;
  /** Explicit control id. `htmlFor` is an alias; either overrides the generated id. */
  id?: string;
  htmlFor?: string;
  required?: boolean;
  className?: string;
}

export default function FormField({
  label,
  children,
  hint,
  error,
  id,
  htmlFor,
  required = false,
  className,
}: FormFieldProps) {
  const generatedId = useId();
  const childProps = children.props;
  const fieldId = htmlFor ?? id ?? (childProps.id as string | undefined) ?? generatedId;

  const hintId = hint != null && hint !== false ? `${fieldId}-hint` : undefined;
  const errorId = error != null && error !== false ? `${fieldId}-error` : undefined;

  const describedBy =
    [childProps["aria-describedby"] as string | undefined, hintId, errorId]
      .filter(Boolean)
      .join(" ") || undefined;

  // Every value here already folds in the caller's own child prop (via the
  // `childProps[...] ?? …` reads and the `fieldId` computation above), so a
  // prop the caller set on the child always wins.
  const injected: Record<string, unknown> = {
    id: fieldId,
    "aria-describedby": describedBy,
  };
  if (errorId) {
    injected["aria-invalid"] = childProps["aria-invalid"] ?? true;
    // Only pass the non-standard `invalid` prop to component controls — on a
    // raw <input>/<select> React would warn about an unknown DOM attribute.
    if (typeof children.type !== "string") {
      injected["invalid"] = childProps["invalid"] ?? true;
    }
  }
  const control = cloneElement(children, injected);

  return (
    <div className={cn(className)}>
      <Label htmlFor={fieldId} required={required}>
        {label}
      </Label>
      {control}
      {hintId && (
        <p id={hintId} className="mt-1 text-xs text-ink-soft">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} className="mt-1 text-xs text-rust">
          {error}
        </p>
      )}
    </div>
  );
}
