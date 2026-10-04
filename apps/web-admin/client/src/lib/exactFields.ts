/**
 * Which pre-filled money/percent fields still hold the exact value the server
 * sent — sent as the request's `exact_fields`.
 *
 * The server reads typed money BY ITS SHAPE (an admin typing `10.000` means
 * ten thousand rupiah), but a value pre-filled from the server is the server's
 * own plain dot-decimal (`100.123` = one hundred point one two three). Naming
 * the untouched pre-filled fields tells the server to read those as plain
 * dot-decimals, so an edit + re-save never turns 100.123 into 100123. A field
 * the admin retyped is left out and read by shape.
 */
export function exactFieldsOf<T extends object>(
  current: T,
  prefill: Partial<T> | null,
  keys: readonly (keyof T & string)[],
): string[] {
  if (!prefill) return [];
  return keys.filter((k) => {
    const original = prefill[k];
    return typeof original === "string" && original !== "" && current[k] === original;
  });
}
