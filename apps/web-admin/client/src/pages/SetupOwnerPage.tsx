import { useState } from "react";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OwnerPostResult {
  ok: boolean;
  redirect: string;
}

export function SetupOwnerPage() {
  const [telegramId, setTelegramId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await publicPost<OwnerPostResult>("/setup/owner", {
        telegram_id: telegramId,
        username,
        password,
        password_confirm: passwordConfirm,
      });
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
          <p className="text-sm text-ink-soft">Step 2 of 3</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">Create owner account</h1>
          <p className="mt-2 text-sm text-ink-soft">
            This will be the main admin account. Get your Telegram ID from{" "}
            <a href="https://t.me/userinfobot" className="text-accent underline" target="_blank" rel="noreferrer">
              @userinfobot
            </a>
            .
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="telegram_id">
              Telegram ID <span className="text-red-500">*</span>
            </Label>
            <Input
              id="telegram_id"
              type="number"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              placeholder="123456789"
              required
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="username">
              Username <span className="text-ink-soft text-xs">(optional)</span>
            </Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@username"
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="password">
              Password <span className="text-red-500">*</span>
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              required
              minLength={8}
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="password_confirm">
              Confirm password <span className="text-red-500">*</span>
            </Label>
            <Input
              id="password_confirm"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="Repeat password"
              required
              disabled={loading}
            />
          </div>

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Creating account…" : "Create account and continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
