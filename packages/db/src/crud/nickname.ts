/**
 * CRUD for resolving `NicknameServiceProviderEntry[]` — the per-provider
 * credential + game-code list `NicknameService` (@app/core/nickname/service)
 * tries in order to answer a live "does this account exist?" lookup.
 *
 * `buildNicknameProviderEntries` extracts the gameId/`ProviderGameMapping`
 * resolution that used to be inlined in the storefront's
 * `apps/storefront/src/routes/apiTopup.ts` (Task 9, nickname-multiprovider
 * plan) so a second caller — the order-bot's nickname-check conversation
 * (Trustance reconciliation Phase B, Task 2) — can reuse the exact same
 * mapping/credential resolution instead of duplicating it. This is a pure
 * extraction: for a `gameId`, the DB reads, credential lookups, and
 * entry-ordering are byte-for-byte what apiTopup.ts's inline block already
 * did (see its own doc comment for the full behavioral contract this
 * mirrors — skipped/unrecognized providers, credential-missing skip, etc.).
 *
 * The `legacyGameCode` fallback (used only when `gameId` resolves to no
 * entries) is NEW: apiTopup.ts's own legacy KokinPay-only block predates
 * `NicknameService` entirely and calls @app/core/suppliers/kokinpay's
 * `checkGameNickname` directly with its own bespoke result-shape mapping, so
 * it is deliberately NOT rewired to call this function — doing so would
 * change its response shape in an edge case (a well-formed `valid:true`
 * result with a falsy nickname maps to "found" for the direct call but to a
 * non-retryable "not found" once routed through `kokinpayProvider`'s
 * `NicknameService` adapter). The fallback exists purely so a fresh caller
 * (the bot) can resolve entries for EITHER path through one function call,
 * matching apiTopup.ts's own precedence rule: `gameId`, when it resolves to
 * at least one entry, always wins over `legacyGameCode`.
 */
import type { NicknameServiceProviderEntry } from "@app/core/nickname/service";
import { createKokinpayNicknameProvider } from "@app/core/nickname/kokinpayProvider";
import { createVipResellerNicknameProvider } from "@app/core/nickname/vipresellerProvider";
import { createMelostoreNicknameProvider } from "@app/core/nickname/melostoreProvider";
import type { Db } from "./_types";
import { getEnabledProviderMappingsForGame } from "./games";
import { getKokinpayCreds } from "./kokinpay";
import { getVipResellerCreds } from "./vipreseller";
import { getMelostoreCreds } from "./melostore";

/**
 * Resolve the ordered `NicknameServiceProviderEntry[]` for one nickname
 * check, from either a `Game` link or the legacy per-denomination game code.
 *
 * `gameId` set: every ENABLED `ProviderGameMapping` row for that game, in
 * ascending `priority` order, each turned into an entry via that provider's
 * credential lookup + adapter factory. A mapping whose provider has no
 * credentials configured is skipped (a config gap, not a lookup failure) —
 * never added to the result. An unrecognized `mapping.provider` string is
 * likewise silently skipped. Byte-for-byte the same resolution
 * apiTopup.ts's inline block performed.
 *
 * `gameId` unset (or resolves to zero entries) and `legacyGameCode` set: a
 * single KokinPay entry (the legacy path is KokinPay-only), or `[]` if no
 * KokinPay credentials are configured.
 *
 * Neither set, or `gameId` set but zero mappings resolve and no
 * `legacyGameCode` given: `[]` — the caller's `NicknameService` will then
 * report `{ status: "no_providers_configured" }`.
 */
export async function buildNicknameProviderEntries(
  db: Db,
  { gameId, legacyGameCode }: { gameId?: number | null; legacyGameCode?: string | null },
): Promise<NicknameServiceProviderEntry[]> {
  if (gameId != null) {
    const mappings = await getEnabledProviderMappingsForGame(db, gameId);
    const entries: NicknameServiceProviderEntry[] = [];
    for (const mapping of mappings) {
      let provider: NicknameServiceProviderEntry["provider"] | null = null;
      if (mapping.provider === "kokinpay") {
        const creds = await getKokinpayCreds(db);
        if (creds) provider = createKokinpayNicknameProvider(creds);
      } else if (mapping.provider === "vipreseller") {
        const creds = await getVipResellerCreds(db);
        if (creds) provider = createVipResellerNicknameProvider(creds);
      } else if (mapping.provider === "melostore") {
        const creds = await getMelostoreCreds(db);
        if (creds) provider = createMelostoreNicknameProvider(creds);
      }
      // An unrecognized `mapping.provider` string (shouldn't happen — admin
      // UI only writes the three known values) is silently skipped, same as
      // a mapping with no credentials configured.
      if (provider) entries.push({ provider, gameCode: mapping.providerGameCode });
    }
    if (entries.length > 0) return entries;
  }

  if (legacyGameCode) {
    const creds = await getKokinpayCreds(db);
    if (creds) return [{ provider: createKokinpayNicknameProvider(creds), gameCode: legacyGameCode }];
  }

  return [];
}
