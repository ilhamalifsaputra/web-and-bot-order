import { useEffect, useState } from "react";

/** Returns `value`, but updated only after it has stopped changing for
 * `delayMs` — the standard debounce-a-fast-changing-input pattern. First
 * shared instance of this in the client; PaymentsPage.tsx's
 * useOrderCodeSuggest has a private one-off setTimeout doing the same thing
 * for one field — this generalizes it for reuse. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
