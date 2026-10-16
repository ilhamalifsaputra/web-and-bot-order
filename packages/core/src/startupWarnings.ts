/**
 * Production hardening warnings, logged once at server startup. A weak
 * setting here never stops the app from booting (a shop on a plain-http
 * staging host must still start) — it only makes the weakness loud.
 *
 * Pure on purpose: callers pass the values in, so it is unit-testable without
 * touching process.env. Warnings never include secret values.
 */
export interface ProductionWarningInput {
  nodeEnv: string | undefined;
  trustProxy: string | undefined;
  cookieSecure: boolean;
  webhookSecret: string | undefined;
}

export const MIN_WEBHOOK_SECRET_LENGTH = 24;

export function collectProductionWarnings(input: ProductionWarningInput): string[] {
  if (input.nodeEnv !== "production") return [];
  const warnings: string[] = [];
  if (!input.trustProxy?.trim()) {
    warnings.push(
      "TRUST_PROXY is not set in production, so X-Forwarded-For is ignored and every request behind a reverse proxy looks like it comes from the proxy's own address, which makes the per-IP login limits shared by all visitors. Set TRUST_PROXY to the reverse proxy's address.",
    );
  }
  if (!input.cookieSecure) {
    warnings.push(
      "WEB_COOKIE_SECURE is false in production, so the admin session cookie can travel over plain http. Set WEB_COOKIE_SECURE=true once the site is served over HTTPS.",
    );
  }
  if (input.webhookSecret !== undefined && input.webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    warnings.push(
      `WEBHOOK_SECRET is shorter than ${MIN_WEBHOOK_SECRET_LENGTH} characters, so the Telegram webhook path is easier to guess. Use a long random value.`,
    );
  }
  return warnings;
}
