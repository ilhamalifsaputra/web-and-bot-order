/**
 * Web cookie secret resolution (setup-wizard spec §6).
 *
 * Priority: env WEB_COOKIE_SECRET (operator override) > DB Setting > generated.
 * When neither env nor DB has one, generate a 32-byte hex secret and persist it
 * so sessions survive restarts without the buyer ever editing .env.
 */
import { randomBytes } from "node:crypto";
import { config } from "@app/core/config";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const WEB_COOKIE_SECRET_KEY = "web_cookie_secret";

export async function resolveWebCookieSecret(db: Db): Promise<string> {
  const env = config.WEB_COOKIE_SECRET;
  if (env && env.length >= 32) return env;

  const existing = await getSetting(db, WEB_COOKIE_SECRET_KEY);
  if (existing && existing.length >= 32) return existing;

  const generated = randomBytes(32).toString("hex"); // 64 hex chars
  await setSetting(db, WEB_COOKIE_SECRET_KEY, generated);
  return generated;
}
