/**
 * Bot-side i18n wrapper. Reads the active language from the session and
 * delegates to the shared `@app/core/i18n` loader (which now serves the full
 * MESSAGES table merged into locales/{en,id}.json).
 */
import { t as coreT } from "@app/core/i18n";
import type { MyContext } from "../context";

export function t(ctx: MyContext, key: string, args: Record<string, unknown> = {}): string {
  return coreT(key, ctx.session.lang, args);
}

/** Direct lookup for code paths without a ctx (jobs, notifier-style). */
export { coreT };
