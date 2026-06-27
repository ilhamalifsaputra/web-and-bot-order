import { useState } from "react";
import { publicPost } from "../api/client";

interface ForgotResult {
  ok: boolean;
  sent: boolean;
  telegram_id?: number | string;
}

export function ForgotPage() {
  const [telegramId, setTelegramId] = useState("");
  const [sent, setSent] = useState(false);
  const [sentTelegramId, setSentTelegramId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await publicPost<ForgotResult>("/forgot", { telegram_id: telegramId });
      if (res.sent) {
        setSentTelegramId(String(res.telegram_id ?? telegramId));
        setSent(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper p-4">
        <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-sm text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink mb-4">Check Telegram</h1>
          <p className="text-sm text-ink-soft mb-6">
            If that ID is a registered admin, a reset code has been sent to your Telegram account. Check your DMs from
            the bot.
          </p>
          <a
            href={`/reset${sentTelegramId ? `?telegram_id=${sentTelegramId}` : ""}`}
            className="inline-block w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Enter reset code
          </a>
          <a href="/login" className="mt-3 block text-sm text-ink-soft hover:text-ink">
            Back to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink mb-2">Forgot password</h1>
        <p className="text-sm text-ink-soft mb-6">
          Enter your Telegram ID and we will send a reset code to your Telegram account.
        </p>

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

          <button
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            type="submit"
            disabled={loading}
          >
            {loading ? "Sending…" : "Send reset code"}
          </button>

          <a href="/login" className="text-center text-sm text-ink-soft hover:text-ink">
            Back to login
          </a>
        </form>
      </div>
    </div>
  );
}
