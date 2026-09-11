import type { NicknameProvider, NicknameLookupOutcome } from "./types";
import { checkNicknameViaVipReseller, type VipResellerCreds } from "../suppliers/vipreseller";

/**
 * Adapts ../suppliers/vipreseller.ts's checkNicknameViaVipReseller to the
 * NicknameProvider contract (packages/core/src/nickname/types.ts). A missing
 * nickname (a normal not-found/no-data outcome) maps to INVALID_TARGET, never
 * a throw; only a genuine failure from the underlying client (network/HTTP/
 * unparseable-response — see vipreseller.ts's own disclaimers, including the
 * ⚠ ASSUMPTION on checkNicknameViaVipReseller about the unverified body.data
 * shape) is caught here and mapped to NETWORK_ERROR. Never let the caught
 * error's message reach the caller — it's discarded, not logged or
 * rethrown, so no request body/credential can leak through this adapter.
 */
export function createVipResellerNicknameProvider(creds: VipResellerCreds): NicknameProvider {
  return {
    id: "vipreseller",
    async checkNickname(req): Promise<NicknameLookupOutcome> {
      try {
        const result = await checkNicknameViaVipReseller(creds, {
          gameCode: req.gameCode,
          id: req.target,
          server: req.server,
        });
        return result.nickname !== null
          ? { ok: true, nickname: result.nickname }
          : { ok: false, errorCode: "INVALID_TARGET" };
      } catch {
        return { ok: false, errorCode: "NETWORK_ERROR" };
      }
    },
  };
}
