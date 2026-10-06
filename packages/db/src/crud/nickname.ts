/**
 * CRUD for resolving `NicknameServiceProviderEntry[]` — the per-provider
 * credential + game-code list `NicknameService` (@app/core/nickname/service)
 * tries in order to answer a live "does this account exist?" lookup.
 *
 * KokinPay is the only nickname-check provider today. Which game (if any)
 * a checkout should run a nickname-check for is resolved by
 * `resolveNicknameGate`: an admin-set per-denomination override
 * (`Denomination.nicknameCheckGameCode`) wins when present; otherwise the
 * game is auto-detected from `Product.digiflazzBrand`/`name` against the
 * static catalog (`@app/core/nickname/gameCatalog`, built from KokinPay's
 * own published game-code list). `buildNicknameProviderEntries` then turns
 * that resolved `gameCode` into the KokinPay provider entry `NicknameService`
 * needs, or `[]` if KokinPay credentials aren't configured.
 *
 * Shared by all 3 call sites that used to spell out gameId/`ProviderGameMapping`
 * resolution independently: `apps/storefront/src/routes/apiTopup.ts`'s
 * POST /topup/check-account, `apps/order-bot/src/handlers/checkout.ts`'s
 * showOrderConfirmation gate, and `apps/order-bot/src/conversations/nicknameCheck.ts`'s
 * own defensive re-check.
 */
import type { NicknameServiceProviderEntry } from "@app/core/nickname/service";
import { createKokinpayNicknameProvider } from "@app/core/nickname/kokinpayProvider";
import { nicknameInputKeys, parseInputFields } from "@app/core/playerInput";
import type { Db } from "./_types";
import { getKokinpayCreds } from "./kokinpay";

/**
 * Resolve the single KokinPay `NicknameServiceProviderEntry` for a resolved
 * `gameCode`, or `[]` if `gameCode` is null or KokinPay credentials aren't
 * configured (a config gap, not a lookup failure — the caller's
 * `NicknameService` then reports `{ status: "no_providers_configured" }`).
 */
export async function buildNicknameProviderEntries(
  db: Db,
  gameCode: string | null,
): Promise<NicknameServiceProviderEntry[]> {
  if (!gameCode) return [];
  const creds = await getKokinpayCreds(db);
  if (!creds) return [];
  return [{ provider: createKokinpayNicknameProvider(creds), gameCode }];
}

/** The minimal structural shape `resolveNicknameGate` actually needs — wide
 * enough that both `getDenominationWithProduct`'s full return shape (the 3
 * pre-checkout call sites) and a narrower Prisma `select` (the reactive
 * Digiflazz-failure diagnostic in crud/digiflazz.ts, which doesn't need the
 * rest of getDenominationWithProduct's `include`) satisfy it structurally,
 * with no extra DB read on either side. Purely a type widening — this
 * function's behavior is unchanged. */
type DenominationForNicknameGate = {
  nicknameCheckGameCode: string | null;
  additionalFields?: string | null;
  providerInputMapping?: string | null;
  /** The Denomination's OWN autoDeliverySource (not a Product field) —
   * passed through to matchGameKey alongside product.digiflazzBrand/name so
   * it can restrict its product.name fallback to Digiflazz-sourced products
   * only (see matchGameKey's own doc comment, packages/core/src/nickname/
   * gameCatalog.ts, for why). Every real caller already selects/includes
   * this as a plain Denomination scalar (getDenominationWithProduct uses no
   * `select`, so it comes along for free; the reactive-diagnostic queries in
   * digiflazz.ts explicitly select it for resolveSingleDigiflazzItem's own
   * needs). */
  autoDeliverySource?: string | null;
  product?: { digiflazzBrand: string | null; name: string } | null;
};

/**
 * The nickname-check opt-in rule — whether a checkout attempt for this
 * denomination should be diverted through a nickname/target-account
 * verification step before payment, and if so, which `gameCode` to check
 * against, plus whether that game needs a zone and/or server prompt.
 *
 * Shared by all 3 call sites (see this file's top-of-file doc comment).
 * Precedence: `Denomination.nicknameCheckGameCode` (an admin-set override),
 * when present, always wins — its `requiresZone`/`requiresServer` are looked
 * up from the static catalog by matching `code` when possible, defaulting to
 * `false` for a hand-typed code that isn't in the catalog. Otherwise the
 * game is auto-detected from `Product.digiflazzBrand`/`name` against the
 * static catalog; no match means no nickname-check for this denomination
 * (`gameCode: null`).
 */
export function resolveNicknameGate(
  denomination: DenominationForNicknameGate | null | undefined,
): { gameCode: string | null; requiresZone: boolean; requiresServer: boolean } {
  const gameCode = denomination?.nicknameCheckGameCode ?? null;
  if (!gameCode) return { gameCode: null, requiresZone: false, requiresServer: false };
  const fields = parseInputFields(denomination?.additionalFields);
  const keys = nicknameInputKeys(fields, denomination?.providerInputMapping);
  return { gameCode, requiresZone: fields.some((f) => f.key === keys.zoneKey && f.required), requiresServer: fields.some((f) => f.key === keys.serverKey && f.required) };
}
