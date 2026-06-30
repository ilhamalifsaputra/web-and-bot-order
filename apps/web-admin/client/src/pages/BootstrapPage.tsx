import { useState } from "react";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
            <Label htmlFor="tg">Telegram ID</Label>
            <Input
              id="tg"
              type="number"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              placeholder="123456789"
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
            {loading ? "Creating…" : "Create account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
