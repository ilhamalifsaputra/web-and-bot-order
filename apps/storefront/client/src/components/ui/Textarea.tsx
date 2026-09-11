/**
 * Textarea — styled native `<textarea>`. Composes `.field` (app.css also
 * gives `textarea.field { resize: vertical }`). `invalid` → `rust` border +
 * `aria-invalid`, matching <Input>. Label/hint/error composition is
 * <FormField>'s job.
 */
import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error styling: `rust` border + `aria-invalid`. */
  invalid?: boolean;
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      // `!border-rust` — see the note in Input.tsx: `.field`'s `border`
      // shorthand in app.css wins on source order without the important flag.
      className={cn("field", invalid && "!border-rust", className)}
      {...rest}
      aria-invalid={rest["aria-invalid"] ?? (invalid || undefined)}
    />
  );
});

export default Textarea;
