import type { NicknameProvider } from "./types";
import { RETRYABLE_NICKNAME_ERROR_CODES } from "./types";

export interface NicknameServiceProviderEntry {
  provider: NicknameProvider;
  gameCode: string;
}

export type NicknameServiceResult =
  | { status: "found"; nickname: string; providerId: NicknameProvider["id"] }
  | { status: "not_found" }
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
      if (!RETRYABLE_NICKNAME_ERROR_CODES.has(outcome.errorCode)) return { status: "not_found" };
      // retryable — loop continues to the next entry
    }
    return { status: "not_found" };
  }
}
