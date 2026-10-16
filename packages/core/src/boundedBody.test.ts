import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyWithLimit } from "./boundedBody";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

describe("readBodyWithLimit", () => {
  it("returns the whole body when it fits", async () => {
    const res = new Response(streamOf([Buffer.from("hello "), Buffer.from("world")]));
    expect((await readBodyWithLimit(res, 100)).toString()).toBe("hello world");
  });

  it("rejects up front when Content-Length already exceeds the limit", async () => {
    const res = new Response("x", { headers: { "content-length": "5000" } });
    await expect(readBodyWithLimit(res, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("aborts mid-stream when a body with no Content-Length grows past the limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(60));
        if (pulled > 50) controller.close();
      },
    });
    await expect(readBodyWithLimit(new Response(body), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBeLessThan(10); // stopped reading, did not drain the stream
  });

  it("accepts a body of exactly the limit", async () => {
    const res = new Response(streamOf([new Uint8Array(100)]));
    expect((await readBodyWithLimit(res, 100)).length).toBe(100);
  });

  it("falls back to arrayBuffer() for responses without a stream body", async () => {
    const bytes = Buffer.from("abc");
    const fake = {
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
    expect((await readBodyWithLimit(fake, 10)).toString()).toBe("abc");
    await expect(readBodyWithLimit(fake, 2)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
