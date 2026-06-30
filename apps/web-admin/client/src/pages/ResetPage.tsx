import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ResetResult {
  ok: boolean;
  redirect: string;
}

export function ResetPage() {
  const [searchParams] = useSearchParams();
  const [telegramId, setTelegramId] = useState(searchParams.get("telegram_id") ?? "");
  const [code, setCode] = useState("");
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
      const res = await publicPost<ResetResult>("/reset", {
        telegram_id: telegramId,
        code,
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
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink mb-2">Reset password</h1>
        <p className="text-sm text-ink-soft mb-6">
          Enter the code sent to your Telegram and choose a new password.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="tg">Telegram ID</Label>
            <Input
              id="tg"
              type="number"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="code">Reset code</Label>
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              required
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="pw">New password</Label>
            <Input
              id="pw"
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
            <Label htmlFor="pw-confirm">Confirm password</Label>
            <Input
              id="pw-confirm"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="Repeat password"
              required
              disabled={loading}
            />
          </div>

          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Resetting…" : "Reset password"}
          </Button>

          <a href="/login" className="text-center text-sm text-ink-soft hover:text-ink">
            Back to login
          </a>
        </form>
      </div>
    </div>
  );
}
