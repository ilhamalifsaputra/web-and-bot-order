/**
 * Recovering from a stale code chunk (H6, UI-states audit).
 *
 * A deploy replaces the hashed chunk files while a tab is still open. The next
 * lazy route that tab opens (Cart, Checkout, Pay…) asks for a file that no
 * longer exists, the dynamic import rejects, and without help the whole app
 * went white. A single reload fetches the new build and fixes it.
 *
 * "Single" matters: if the chunk is missing for some other reason (a broken
 * deploy, a proxy serving HTML), reloading again and again would trap the buyer
 * in a reload loop. A sessionStorage timestamp allows one automatic reload per
 * RELOAD_WINDOW_MS; inside that window the error boundary shows its message and
 * a Reload button instead. When storage is unavailable no automatic reload
 * happens at all, for the same reason.
 */
const KEY = "storefront.chunk_reload_at";
const RELOAD_WINDOW_MS = 5 * 60_000;

/** A failed dynamic import or module preload, as the browsers word it. */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ChunkLoadError") return true;
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(err.message);
}

/** Reload once for a stale chunk; false (and no reload) when one already
 * happened recently or the guard cannot be stored. */
export function reloadOnceForStaleChunk(reload: () => void = () => window.location.reload(), now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? "");
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Vite fires `vite:preloadError` when a dynamic import's preload fails. Taking
 * the one guarded reload here (and suppressing the error) is the cleanest
 * recovery; when the guard refuses, the error is left to reach the route's
 * error boundary.
 */
export function installStaleChunkReload(target: Window = window, reload?: () => void): () => void {
  const onPreloadError = (event: Event) => {
    if (reloadOnceForStaleChunk(reload)) event.preventDefault();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
