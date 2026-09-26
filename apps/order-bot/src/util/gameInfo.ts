/**
 * Game Top Up "game info" helpers for the order-bot's picker/detail bubbles.
 *
 * There is no Game model: a "game" is a Product under a GAME_TOPUP category.
 * What the buyer will be asked for at checkout (User ID, plus Zone ID and/or
 * Server ID) comes from the static GAME_CATALOG via the same
 * `resolveNicknameGate` rule the checkout gate itself uses, so the hint shown
 * while browsing can never promise a different set of inputs than checkout
 * actually asks for.
 */
import { resolveNicknameGate } from "@app/db";

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
 * The input flags for the first denomination that maps to a GAME_CATALOG
 * entry (admin override or auto-detected), or null when none does — an
 * unknown game gets no hint rather than a guessed one.
 */
export function resolveGameInputFlags(denominations: GateDenomination[]): GameInputFlags | null {
  for (const d of denominations) {
    const gate = resolveNicknameGate(d);
    if (gate.gameCode) return { requiresZone: gate.requiresZone, requiresServer: gate.requiresServer };
  }
  return null;
}
