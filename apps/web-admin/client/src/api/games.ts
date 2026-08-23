/**
 * Admin API for the multi-provider nickname-check catalog layer (Task 10's
 * `/api/games*` routes): Game list/detail plus each Game's provider mappings.
 * GamesPage reads the list query; GameDetailPage reads the per-id query so a
 * mapping add/edit/delete only refetches the one game, not the whole list.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

/** The only providers the multi-provider nickname-check flow knows how to
 * call (mirrors apps/web-admin/src/routes/api/games.ts's VALID_PROVIDERS). */
export const PROVIDERS = ["kokinpay", "vipreseller", "melostore"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  kokinpay: "KokinPay",
  vipreseller: "VIP-Reseller",
  melostore: "MeloStore",
};

/** Human label for a provider id — falls back to the raw string for
 * anything unrecognized rather than throwing (defensive against a mapping
 * row whose provider predates a future addition to PROVIDERS). */
export function providerLabel(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
}

export interface ProviderMappingRow {
  id: number;
  gameId: number;
  provider: string;
  providerGameCode: string;
  enabled: boolean;
  priority: number;
}

export interface GameRow {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  nicknameSupported: boolean;
  requiresZone: boolean;
  requiresServer: boolean;
  isActive: boolean;
  providerMappings: ProviderMappingRow[];
}

export const GAMES_QUERY_KEY = ["games"] as const;

export function useGames() {
  return useQuery<{ games: GameRow[] }>({
    queryKey: GAMES_QUERY_KEY,
    queryFn: async () => apiGet<{ games: GameRow[] }>("/api/games"),
  });
}

export function gameQueryKey(gameId: string) {
  return ["games", gameId] as const;
}

export function useGame(gameId: string) {
  return useQuery<{ game: GameRow }>({
    queryKey: gameQueryKey(gameId),
    queryFn: async () => apiGet<{ game: GameRow }>(`/api/games/${gameId}`),
    enabled: !!gameId,
  });
}
