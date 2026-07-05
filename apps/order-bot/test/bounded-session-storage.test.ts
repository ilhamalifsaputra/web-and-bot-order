import { describe, it, expect } from "vitest";
import { boundedSessionStorage } from "../src/util/boundedSessionStorage";

describe("boundedSessionStorage", () => {
  it("reads back a written value", () => {
    const storage = boundedSessionStorage<number>(3);
    storage.write("a", 1);
    expect(storage.read("a")).toBe(1);
  });

  it("returns undefined for a missing key", () => {
    const storage = boundedSessionStorage<number>(3);
    expect(storage.read("missing")).toBeUndefined();
  });

  it("deletes a key", () => {
    const storage = boundedSessionStorage<number>(3);
    storage.write("a", 1);
    storage.delete("a");
    expect(storage.read("a")).toBeUndefined();
  });

  it("evicts the least-recently-used entry once the cap is exceeded", () => {
    const storage = boundedSessionStorage<number>(2);
    storage.write("a", 1);
    storage.write("b", 2);
    storage.write("c", 3); // cap is 2 — "a" (oldest, untouched) should be evicted
    expect(storage.read("a")).toBeUndefined();
    expect(storage.read("b")).toBe(2);
    expect(storage.read("c")).toBe(3);
  });

  it("reading a key refreshes its recency, protecting it from eviction", () => {
    const storage = boundedSessionStorage<number>(2);
    storage.write("a", 1);
    storage.write("b", 2);
    storage.read("a"); // "a" is now more recently used than "b"
    storage.write("c", 3); // should evict "b", not "a"
    expect(storage.read("a")).toBe(1);
    expect(storage.read("b")).toBeUndefined();
    expect(storage.read("c")).toBe(3);
  });

  it("readAllKeys/readAllValues/readAllEntries reflect current contents", () => {
    const storage = boundedSessionStorage<number>(5);
    storage.write("a", 1);
    storage.write("b", 2);
    expect(Array.from(storage.readAllKeys!() as Iterable<string>)).toEqual(["a", "b"]);
    expect(Array.from(storage.readAllValues!() as Iterable<number>)).toEqual([1, 2]);
    expect(Array.from(storage.readAllEntries!() as Iterable<[string, number]>)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
