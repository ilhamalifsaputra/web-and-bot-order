import { useState } from "react";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
          <Label htmlFor="bot_token">Bot token</Label>
          <Input
            id="bot_token"
            type="text"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456789:ABCDEF..."
            disabled={loading}
          />
        </div>

        <div className="flex flex-col gap-3">
          <Button
            type="button"
            onClick={() => void handleSubmit(false)}
            disabled={loading || !botToken.trim()}
            className="w-full"
          >
            {loading ? "Saving…" : "Save and continue"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSubmit(true)}
            disabled={loading}
            className="w-full"
          >
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}
