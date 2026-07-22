/**
 * SMTP credentials for the storefront's forgot-password email
 * (packages/core/src/mailer.ts). Resolved from web-admin Settings (with the
 * SMTP_* env vars as the bootstrap/recovery fallback) — same pattern as
 * resolveBybitConfig/getTokopayCreds: no restart needed, an edit takes effect
 * on the next `/auth/forgot` call (bounded by getSetting's 30s cache).
 */
import { config } from "@app/core/config";
import type { SmtpCreds } from "@app/core/mailer";
import type { Db } from "./_types";
import { getSetting } from "./settings";

export const SMTP_HOST_KEY = "smtp_host";
export const SMTP_PORT_KEY = "smtp_port";
export const SMTP_USER_KEY = "smtp_user";
export const SMTP_PASS_KEY = "smtp_pass";
export const SMTP_FROM_KEY = "smtp_from";
export const SMTP_SECURE_KEY = "smtp_secure";

/** First non-empty (trimmed) value, else "". DB value wins over the env fallback. */
function pick(dbVal: string | null, envVal?: string): string {
  const a = (dbVal ?? "").trim();
  if (a) return a;
  return (envVal ?? "").trim();
}

/** Resolve SMTP creds from Settings (env fallback). Null when unconfigured —
 * host or from-address blank means the forgot-password email feature is off. */
export async function getSmtpCreds(db: Db): Promise<SmtpCreds | null> {
  const [hostSetting, portSetting, userSetting, passSetting, fromSetting, secureSetting] = await Promise.all([
    getSetting(db, SMTP_HOST_KEY),
    getSetting(db, SMTP_PORT_KEY),
    getSetting(db, SMTP_USER_KEY),
    getSetting(db, SMTP_PASS_KEY),
    getSetting(db, SMTP_FROM_KEY),
    getSetting(db, SMTP_SECURE_KEY),
  ]);

  const host = pick(hostSetting, config.SMTP_HOST);
  const from = pick(fromSetting, config.SMTP_FROM);
  if (!host || !from) return null;

  const portRaw = pick(portSetting, String(config.SMTP_PORT));
  const parsedPort = Number(portRaw);
  const port = Number.isFinite(parsedPort) && Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : config.SMTP_PORT;

  const secureRaw = pick(secureSetting, config.SMTP_SECURE ? "true" : "false");
  const secure = secureRaw.toLowerCase() === "true";

  return {
    host,
    port,
    secure,
    user: pick(userSetting, config.SMTP_USER),
    pass: pick(passSetting, config.SMTP_PASS),
    from,
  };
}
