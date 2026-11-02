import { useSyncExternalStore } from "react";

/**
 * "This tab's admin session has ended", as one shared flag.
 *
 * `api/client.ts` raises it the moment any `/api/*` response is a 401 (the server
 * answers a missing or expired session with JSON 401, never a redirect, because a
 * redirect would be followed silently by `fetch`). The flag is a single boolean,
 * so a polling query that keeps failing the same way can never stack a second
 * banner. It clears itself as soon as any request succeeds again, for instance
 * after the admin logged in from another tab.
 */
let expired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  emit();
}

export function clearSessionExpired(): void {
  if (!expired) return;
  expired = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): boolean {
  return expired;
}

export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A 401 from the API: the session is gone, so retrying cannot help. */
export function isSessionExpiredError(error: unknown): boolean {
  return statusOf(error) === 401;
}

/**
 * React Query `retry` policy: never repeat a request the server refused for who
 * is asking (401 session ended, 403 not allowed) — repeating only delays the
 * explanation by seconds. Every other failure keeps React Query's default of
 * three retries.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 403) return false;
  return failureCount < 3;
}
