/** Legacy redirect adapter. Decoding proves structure only; the server verifies HMAC. */
const FIELDS = new Set(["id", "auth_date", "hash", "first_name", "last_name", "username", "photo_url"]);
export function parseTelegramFragment(hash: string): Record<string, string> | null {
  const entries = hash.replace(/^#/, "").split("&");
  const matches = entries.filter(entry => decodeURIComponent(entry.split("=", 1)[0] ?? "") === "tgAuthResult");
  if (!matches.length) return null;
  if (hash.length > 16384 || matches.length !== 1 || entries.length !== 1) throw new Error("Invalid Telegram callback");
  const encoded = decodeURIComponent(matches[0]!.slice(matches[0]!.indexOf("=") + 1));
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new Error("Invalid Telegram callback");
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telegram callback");
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!FIELDS.has(key) || (typeof field !== "string" && !(typeof field === "number" && (key === "id" || key === "auth_date")))) throw new Error("Invalid Telegram callback");
    result[key] = String(field);
    if (result[key]!.length > 4096) throw new Error("Invalid Telegram callback");
  }
  if (!/^[1-9]\d*$/.test(result.id ?? "") || !Number.isSafeInteger(Number(result.id)) || !/^[1-9]\d*$/.test(result.auth_date ?? "") || !Number.isSafeInteger(Number(result.auth_date)) || !/^[a-f0-9]{64}$/.test(result.hash ?? "")) throw new Error("Invalid Telegram callback");
  return result;
}
const safePath = (path: string) => path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(path) ? path : "/";
interface CallbackLocation { pathname: string; search: string; hash: string }
interface CallbackEffects { replace: (path: string) => void; post: (url: string, body: unknown) => Promise<{ redirect: string }>; navigate: (path: string) => void }
export async function consumeTelegramFragment(location: CallbackLocation, effects: CallbackEffects): Promise<boolean> {
  if (!["/auth/telegram", "/account/settings/link-telegram"].includes(location.pathname)) return false;
  const hash = location.hash;
  const params = new URLSearchParams(location.search);
  // Erase the fragment and state before parsing, network calls, or mounting analytics.
  const state = params.get("state") ?? "";
  params.delete("state");
  effects.replace(location.pathname + (params.size ? `?${params}` : ""));
  const next = safePath(params.get("next") ?? "/");
  try {
    const data = parseTelegramFragment(hash);
    if (!data || !state) throw new Error("Invalid Telegram callback");
    const result = await effects.post(location.pathname, { ...data, state, next });
    effects.navigate(safePath(result.redirect));
  } catch {
    effects.navigate(location.pathname === "/auth/telegram" ? `/login?${new URLSearchParams({ next, err: "tg_failed" })}` : "/account/settings?err=tg_invalid");
  }
  return true;
}
