import { useState } from "react";
import { publicPost } from "../api/client";

interface BotPostResult {
  ok: boolean;
  redirect: string;
}

export function SetupBotPage() {
  const [botToken, setBotToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(skip: boolean) {
    setError(null);
    setLoading(true);
    try {
      const body = skip ? { skip: "1" } : { bot_token: botToken };
      const result = await publicPost<BotPostResult>("/setup/bot", body);
      if (result.ok) {
        window.location.href = result.redirect;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <p className="text-sm text-ink-soft">Step 1 of 3</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">Connect your bot</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Paste the token you received from{" "}
            <a href="https://t.me/BotFather" className="text-accent underline" target="_blank" rel="noreferrer">
              @BotFather
            </a>
            . You can configure this later in Settings.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="mb-6">
          <label htmlFor="bot_token" className="mb-1 block text-sm font-medium text-ink">
            Bot token
          </label>
          <input
            id="bot_token"
            type="text"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456789:ABCDEF..."
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            disabled={loading}
          />
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void handleSubmit(false)}
            disabled={loading || !botToken.trim()}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {loading ? "Saving…" : "Save and continue"}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit(true)}
            disabled={loading}
            className="w-full rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper disabled:opacity-40"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
