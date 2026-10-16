/**
 * Read an upstream HTTP response body without letting it grow past a limit.
 *
 * `await res.arrayBuffer()` / `res.text()` buffers whatever the remote end
 * sends, so a hostile or broken upstream can exhaust the process's memory.
 * Callers that proxy or parse a download (Telegram files, in practice) read
 * it through here: a declared Content-Length above the limit is refused
 * before any byte is read, and a body with no (or a lying) Content-Length is
 * counted as it streams and cancelled the moment it crosses the limit.
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The response body is larger than the ${maxBytes}-byte limit.`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!res.body) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > maxBytes) throw new BodyTooLargeError(maxBytes);
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
