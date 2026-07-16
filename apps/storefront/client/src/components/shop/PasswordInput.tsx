/**
 * Shared password `<input>` with a show/hide toggle (STO-015) — a drop-in
 * replacement for `<input className="field" type="password" ... />` used
 * verbatim across Login/Register/Settings. Hand-rolled, matching this app's
 * existing small-component convention (see `Flash.tsx`) — no new dependency.
 *
 * Every prop except `type` (always starts as "password") passes straight
 * through to the underlying `<input>`, so existing uncontrolled usage (read
 * via `FormData` at submit, e.g. LoginPage/RegisterPage/SettingsPage) and
 * controlled usage both keep working unchanged.
 */
import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "../../lib/i18n";

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export default function PasswordInput({ className = "", id, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="relative">
      <input
        {...rest}
        id={inputId}
        type={visible ? "text" : "password"}
        className={`${className} pr-10`.trim()}
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
