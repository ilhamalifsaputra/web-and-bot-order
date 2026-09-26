/**
 * Game Top Up "game info" helpers for the order-bot's picker/detail bubbles.
 *
 * There is no Game model: a "game" is a Product under a GAME_TOPUP category.
 * The "data needed at checkout" hint (User ID, plus Zone ID and/or Server ID)
 * is shown only when checkout will actually run the nickname-check wizard
 * that asks for exactly those inputs — i.e. the same two-step gate
 * checkout.ts's showOrderConfirmation applies: `resolveNicknameGate` resolves
 * a gameCode (admin override or GAME_CATALOG auto-detect) AND
 * `buildNicknameProviderEntries` returns at least one provider (KokinPay
 * credentials configured). Otherwise checkout never asks for these fields,
 * so the hint is omitted rather than promising inputs that won't be asked.
 */
import { prisma, resolveNicknameGate, buildNicknameProviderEntries } from "@app/db";
import { logger } from "@app/core/logger";

export interface GameInputFlags {
  requiresZone: boolean;
  requiresServer: boolean;
}

/** "User ID", "User ID, Zone ID", "User ID, Server ID", … — `tr` is the
 * caller's locale lookup (keys `browse.game_field_*`). Pure. */
export function gameInputFieldsLabel(tr: (key: string) => string, flags: GameInputFlags): string {
  const fields = [tr("browse.game_field_user_id")];
  if (flags.requiresZone) fields.push(tr("browse.game_field_zone_id"));
  if (flags.requiresServer) fields.push(tr("browse.game_field_server_id"));
  return fields.join(", ");
}

type GateDenomination = Parameters<typeof resolveNicknameGate>[0];

/**
 * The input flags for the first denomination whose checkout will run the
 * nickname-check wizard (see this file's header for the gate), or null when
 * none will. A provider lookup failure (e.g. an undecryptable KokinPay key)
 * degrades to null — a browse screen must never fail over an optional hint.
 */
export async function resolveGameInputFlags(denominations: GateDenomination[]): Promise<GameInputFlags | null> {
  for (const d of denominations) {
    const gate = resolveNicknameGate(d);
    if (!gate.gameCode) continue;
    try {
      const entries = await buildNicknameProviderEntries(prisma, gate.gameCode);
      if (entries.length === 0) return null; // provider config is global: no creds for one means none for all
      return { requiresZone: gate.requiresZone, requiresServer: gate.requiresServer };
    } catch (err) {
      logger.warn(
        { err },
        "Could not load the nickname-check provider settings while rendering a Game Top Up screen, so the account-data hint was left out. Checkout will hit the same error if it persists.",
      );
      return null;
    }
  }
  return null;
}
