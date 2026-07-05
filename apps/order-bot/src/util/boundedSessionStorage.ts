/**
 * Bounded in-memory session storage for grammY's `session()` middleware.
 *
 * The default `MemorySessionStorage` grammY falls back to when no `storage:`
 * is given is an unbounded `Map` keyed by chat id — every distinct chat that
 * has ever messaged the bot stays in RAM for the life of the process. This
 * adapter wraps a `Map` with LRU eviction so RAM has a hard ceiling even if
 * the bot runs for weeks without a restart. Session data is scratch/nav
 * state only (source of truth lives in the DB), so evicting an inactive
 * chat's entry just resets it to `initialSession()` on its next update.
 */
import type { StorageAdapter } from "grammy";

export function boundedSessionStorage<T>(maxEntries: number): StorageAdapter<T> {
  const store = new Map<string, T>();

  function touch(key: string, value: T) {
    // Re-inserting moves the key to the end (most-recently-used) in Map's
    // iteration order, which is what makes `keys().next()` below the LRU.
    store.delete(key);
    store.set(key, value);
  }

  return {
    read(key) {
      const value = store.get(key);
      if (value !== undefined) touch(key, value);
      return value;
    },
    write(key, value) {
      touch(key, value);
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    delete(key) {
      store.delete(key);
    },
    readAllKeys() {
      return store.keys();
    },
    readAllValues() {
      return store.values();
    },
    readAllEntries() {
      return store.entries();
    },
  };
}
