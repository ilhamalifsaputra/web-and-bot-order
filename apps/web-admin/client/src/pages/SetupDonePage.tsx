import { useState } from "react";
import { publicPost } from "../api/client";

interface RestartResult {
  ok: boolean;
  restarted: boolean;
  bot_configured: boolean;
}

function getBotConfigured(): boolean {
  return (
    document.querySelector('meta[name="setup-bot-configured"]')?.getAttribute("content") === "true"
  );
}

export function SetupDonePage() {
  const [restarted, setRestarted] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const botConfigured = getBotConfigured();

  async function handleRestart() {
    setRestartError(null);
    setLoading(true);
    try {
      const result = await publicPost<RestartResult>("/setup/restart", {});
      if (result.restarted) {
        setRestarted(true);
      } else {
        setRestartError(
          "Could not write the restart trigger file automatically. Please restart the server from your hosting panel."
        );
      }
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : "Restart failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-8 shadow-sm text-center">
        <div className="mb-2 text-4xl">🎉</div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Setup complete!</h1>
        <p className="mt-2 text-sm text-ink-soft">
          You are now logged in as the owner. Your shop is ready to use.
        </p>

        {!botConfigured && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong>Bot not configured.</strong> You skipped the bot token step. To connect your Telegram
            bot, go to <strong>Settings</strong> after the server restarts and enter your bot token there.
          </div>
        )}

        {restarted ? (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            Restart signal written. The server will reboot shortly — please wait a few seconds, then go to the
            dashboard.
          </div>
        ) : (
          <>
            {restartError && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {restartError}
              </div>
            )}
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => void handleRestart()}
                disabled={loading}
                className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {loading ? "Restarting…" : "Restart server"}
              </button>
              <a
                href="/"
                className="w-full rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper inline-block"
              >
                Go to dashboard
              </a>
            </div>
          </>
        )}

        {restarted && (
          <div className="mt-4">
            <a
              href="/"
              className="inline-block w-full rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper"
            >
              Go to dashboard
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
