/** Runs independent requests with a fixed concurrency cap and preserves input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Concurrency must be a positive integer.");
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await task(items[index]!);
    return worker();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
