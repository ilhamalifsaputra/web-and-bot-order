export type NicknameErrorCode =
  | "TIMEOUT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR" | "RATE_LIMITED"
  | "NETWORK_ERROR" | "GAME_NOT_SUPPORTED"
  | "INVALID_TARGET" | "INVALID_ZONE" | "INVALID_SERVER" | "INVALID_REQUEST";

export const RETRYABLE_NICKNAME_ERROR_CODES: ReadonlySet<NicknameErrorCode> = new Set([
  "TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "RATE_LIMITED", "NETWORK_ERROR", "GAME_NOT_SUPPORTED",
]);

export interface NicknameRequest {
  gameCode: string;
  target: string;
  zone?: string;
  server?: string;
}

export type NicknameLookupOutcome =
  | { ok: true; nickname: string }
  | { ok: false; errorCode: NicknameErrorCode };

export interface NicknameProvider {
  readonly id: "kokinpay";
  checkNickname(req: NicknameRequest): Promise<NicknameLookupOutcome>;
}
