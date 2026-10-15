// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTgText } from "../src/conversations/admin";
import type { MyContext } from "../src/context";

// Backend audit B13: the admin stock-upload download buffered whatever Telegram
// sent, even though only Telegram's (optional, client-trustable) file_size was
// ever checked against the 1 MB cap.
const ctx = { api: { getFile: async () => ({ file_path: "documents/stock.txt" }) } } as unknown as MyContext;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadTgText", () => {
  it("returns the text of a small file", async () => {
    vi.stubGlobal("fetch", async () => new Response("a@b.c:pw\nd@e.f:pw2\n"));
    expect(await downloadTgText(ctx, "FILE")).toBe("a@b.c:pw\nd@e.f:pw2\n");
  });

  it("returns null when Content-Length declares more than 1 MB, without reading the body", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { headers: { "content-length": "5000000" } }));
    expect(await downloadTgText(ctx, "FILE")).toBeNull();
  });

  it("returns null and stops reading when an undeclared body streams past 1 MB", async () => {
    let chunks = 0;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunks += 1;
              controller.enqueue(new Uint8Array(200_000));
              if (chunks > 100) controller.close();
            },
          }),
        ),
    );
    expect(await downloadTgText(ctx, "FILE")).toBeNull();
    expect(chunks).toBeLessThan(20);
  });
});
