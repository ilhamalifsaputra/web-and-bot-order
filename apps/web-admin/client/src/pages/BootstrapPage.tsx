import { useState } from "react";
import { publicPost } from "../api/client";

interface BootstrapResult {
  ok: boolean;
  redirect: string;
}

function getAdminIds(): number[] {
  try {
    const content = document.querySelector('meta[name="admin-ids"]')?.getAttribute("content");
    if (!content) return [];
    return JSON.parse(content) as number[];
  } catch {
    return [];
  }
}

export function BootstrapPage() {
  const adminIds = getAdminIds();
  const [telegramId, setTelegramId] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await publicPost<BootstrapResult>("/bootstrap", {
        telegram_id: telegramId,
        password,
        password_confirm: passwordConfirm,
      });
      window.location.href = res.redirect;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink mb-2">Create admin account</h1>
        <p className="text-sm text-ink-soft mb-2">
          Set the password for the first web admin account.
        </p>
        {adminIds.length > 0 && (
          <p className="mb-6 text-xs text-ink-soft">
            Allowed Telegram IDs:{" "}
            <span className="font-mono">{adminIds.join(", ")}</span>
          </p>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="tg">
              Telegram ID
            </label>
            <input
              id="tg"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              type="number"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              placeholder="123456789"
              required
              disabled={loading}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="pw">
              Password
            </label>
            <input
              id="pw"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              minLength={8}
              required
              disabled={loading}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="pw-confirm">
              Confirm password
            </label>
            <input
              id="pw-confirm"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="Repeat password"
              required
              disabled={loading}
            />
          </div>

          <button
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            type="submit"
            disabled={loading}
          >
            {loading ? "Creating…" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
