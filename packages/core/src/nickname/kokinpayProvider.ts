import type { NicknameProvider, NicknameLookupOutcome } from "./types";
import { checkGameNickname, type KokinpayCreds } from "../suppliers/kokinpay";

export function createKokinpayNicknameProvider(creds: KokinpayCreds): NicknameProvider {
  return {
    id: "kokinpay",
    async checkNickname(req): Promise<NicknameLookupOutcome> {
      try {
        const result = await checkGameNickname(creds, { gameCode: req.gameCode, id: req.target, server: req.server ?? req.zone });
        // KokinPay's client folds "not found" and "invalid game_code" into
        // the same {valid:false} shape per its own docs (see
        // suppliers/kokinpay.ts) — this adapter conservatively maps both to
        // INVALID_TARGET (non-retryable), a documented limitation.
        return result.valid && result.nickname ? { ok: true, nickname: result.nickname } : { ok: false, errorCode: "INVALID_TARGET" };
      } catch {
        return { ok: false, errorCode: "NETWORK_ERROR" };
      }
    },
  };
}
