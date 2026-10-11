/** Keys for read-only projections without server IDs. Equal content is interchangeable;
 * occurrence counts distinguish duplicate content without tying identity to list position. */
export function keyedContent<T>(items: readonly T[], identity: (item: T) => string = item => JSON.stringify(item)) {
  const occurrences = new Map<string, number>();
  return items.map(item => {
    const content = identity(item);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { item, key: JSON.stringify([content, occurrence]) };
  });
}
