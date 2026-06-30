import { useState } from "react";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
            <Label htmlFor="pw">Password</Label>
            <Input
              id="pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          {showTotp && (
            <div>
              <Label htmlFor="totp">2FA Code</Label>
              <Input
                id="totp"
                type="text"
                inputMode="numeric"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                autoComplete="one-time-code"
                disabled={loading}
              />
            </div>
          )}

          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>

          <a href="/forgot" className="text-center text-sm text-ink-soft hover:text-ink">
            Forgot password?
          </a>
        </form>
      </div>
    </div>
  );
}
