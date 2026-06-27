import { useState } from "react";
import { publicPost } from "../api/client";

interface LoginResult {
  ok: boolean;
  redirect: string;
}

export function LoginPage() {
  const [telegramId, setTelegramId] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showTotp, setShowTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await publicPost<LoginResult>("/login", {
        telegram_id: telegramId,
        password,
        ...(totpCode ? { totp_code: totpCode } : {}),
      });
      window.location.href = res.redirect;
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      if (
        msg.toLowerCase().includes("2fa") ||
        msg.toLowerCase().includes("authenticator") ||
        msg.toLowerCase().includes("totp")
      ) {
        setShowTotp(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink mb-6">Shop Admin</h1>

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
              required
              disabled={loading}
            />
          </div>

          {showTotp && (
            <div>
              <label className="mb-1 block text-sm font-medium text-ink" htmlFor="totp">
                2FA Code
              </label>
              <input
                id="totp"
                className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                type="text"
                inputMode="numeric"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                autoComplete="one-time-code"
                disabled={loading}
              />
            </div>
          )}

          <button
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            type="submit"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <a href="/forgot" className="text-center text-sm text-ink-soft hover:text-ink">
            Forgot password?
          </a>
        </form>
      </div>
    </div>
  );
}
