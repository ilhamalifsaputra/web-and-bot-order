import type { NicknameProvider, NicknameLookupOutcome } from "./types";
import { checkGameNickname, type MelostoreCreds } from "../suppliers/melostore";

/**
 * MeloStore adapter for the multi-provider NicknameService. Maps
 * suppliers/melostore.ts's NicknameCheckResult onto the shared
 * NicknameLookupOutcome shape. Unlike kokinpayProvider.ts, MeloStore's
 * client surfaces two distinct documented non-throwing failure codes
 * (4001 "Account not found" and 4006 "Target parameter input is
 * incomplete or invalid") via `errorCode`, so this adapter distinguishes
 * them instead of folding both into a single NicknameErrorCode: 4006 maps
 * to INVALID_REQUEST (malformed input) and everything else non-valid —
 * including 4001 and the edge case of `valid:true` with no nickname — maps
 * to INVALID_TARGET (target not found), same fail-safe-to-"not this"
 * default kokinpayProvider.ts uses for its single undifferentiated case.
 */
export function createMelostoreNicknameProvider(creds: MelostoreCreds): NicknameProvider {
  return {
    id: "melostore",
    async checkNickname(req): Promise<NicknameLookupOutcome> {
      try {
        const result = await checkGameNickname(creds, { gameCode: req.gameCode, id: req.target, server: req.server });
        if (result.valid && result.nickname) return { ok: true, nickname: result.nickname };
        if (result.errorCode === 4006) return { ok: false, errorCode: "INVALID_REQUEST" };
        return { ok: false, errorCode: "INVALID_TARGET" };
      } catch {
        return { ok: false, errorCode: "NETWORK_ERROR" };
      }
    },
  };
}
