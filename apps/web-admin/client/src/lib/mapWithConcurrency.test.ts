import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency";

describe("mapWithConcurrency", () => {
  it("caps active requests and returns results in input order", async () => {
    const release = new Map<number, (result: string) => void>();
    const started: number[] = [];
    const request = mapWithConcurrency([1, 2, 3], 2, id => {
      started.push(id);
      return new Promise<string>(resolve => release.set(id, resolve));
    });
    expect(started).toEqual([1, 2]);
    release.get(2)!("second");
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    release.get(3)!("third");
    release.get(1)!("first");
    await expect(request).resolves.toEqual(["first", "second", "third"]);
  });
  it("handles empty input without starting work", async () => {
    await expect(mapWithConcurrency([], 2, async () => { throw new Error("Unexpected request."); })).resolves.toEqual([]);
  });
});
