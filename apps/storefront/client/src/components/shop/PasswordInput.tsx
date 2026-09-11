/**
 * Shared password `<input>` with a show/hide toggle (STO-015) — a drop-in
 * replacement for `<input className="field" type="password" ... />` used
 * verbatim across Login/Register/Reset/Settings.
 *
 * Task 15: refactored onto `<Input>` (`components/ui/Input.tsx`) internals so
 * it picks up the design system's `.field`/`invalid` styling instead of
 * hand-rolling its own — the show/hide toggle behavior, its `aria-label`s,
 * and the "every prop but `type` passes through" contract are unchanged. It
 * composes with `<FormField>`: since this is a component (not a raw DOM tag),
 * FormField's `cloneElement` also injects the non-standard `invalid` prop
 * alongside `id`/`aria-describedby`/`aria-invalid`, all forwarded here via
 * `...rest`/`invalid` straight through to the inner `<Input>`.
 *
 * Every prop except `type` (always starts as "password") passes straight
 * through, so existing uncontrolled usage (read via `FormData` at submit,
 * e.g. LoginPage/RegisterPage/ResetPage/SettingsPage) and controlled usage
 * both keep working unchanged.
 */
import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "../../lib/i18n";
import Input, { type InputProps } from "../ui/Input";
import { cn } from "../ui/cn";

export type PasswordInputProps = Omit<InputProps, "type">;

export default function PasswordInput({ className, id, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="relative">
      <Input
        {...rest}
        id={inputId}
        type={visible ? "text" : "password"}
        className={cn(className, "pr-10")}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-faint hover:text-ink-soft"
        aria-label={visible ? t("web.password_hide") : t("web.password_show")}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
