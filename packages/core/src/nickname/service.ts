import type { NicknameProvider } from "./types";
import { RETRYABLE_NICKNAME_ERROR_CODES } from "./types";

export interface NicknameServiceProviderEntry {
  provider: NicknameProvider;
  gameCode: string;
}

export type NicknameServiceResult =
  | { status: "found"; nickname: string; providerId: NicknameProvider["id"] }
  // `definitive: true` means a provider gave a clear non-retryable answer
  // (e.g. "no such account") and the service stopped early without trying
  // any lower-priority providers. `definitive: false` means every entry was
  // tried and each one failed with a retryable error (or `entries` was
  // non-empty but never produced an answer) — a "we couldn't determine
  // anything" outcome, not a "the account doesn't exist" one. Callers must
  // not conflate the two: only `definitive: true` is safe to surface to a
  // buyer as "account not found".
  | { status: "not_found"; definitive: boolean }
  | { status: "no_providers_configured" };

export class NicknameService {
  constructor(private readonly entries: NicknameServiceProviderEntry[]) {}

  async checkNickname(req: { target: string; zone?: string; server?: string }): Promise<NicknameServiceResult> {
    if (this.entries.length === 0) return { status: "no_providers_configured" };
    for (const entry of this.entries) {
      const outcome = await entry.provider.checkNickname({
        gameCode: entry.gameCode,
        target: req.target,
        zone: req.zone,
        server: req.server,
      });
      if (outcome.ok) return { status: "found", nickname: outcome.nickname, providerId: entry.provider.id };
      if (!RETRYABLE_NICKNAME_ERROR_CODES.has(outcome.errorCode)) return { status: "not_found", definitive: true };
      // retryable — loop continues to the next entry
    }
    return { status: "not_found", definitive: false };
  }
}
