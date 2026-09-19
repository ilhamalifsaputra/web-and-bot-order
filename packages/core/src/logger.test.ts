import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, safeErr } from "./logger";

// Structurally identical to grammy's GrammyError (grammy is not resolvable from
// packages/core): `payload` and `method` are own enumerable properties.
class FakeGrammyError extends Error {
  method: string;
  payload: unknown;
  ok = false as const;
  error_code: number;
  description: string;
  parameters = {};
  constructor(
    message: string,
    err: { error_code: number; description: string },
    method: string,
    payload: unknown,
  ) {
    super(`${message} (${err.error_code}: ${err.description})`);
    this.name = "GrammyError";
    this.method = method;
    this.payload = payload;
    this.error_code = err.error_code;
    this.description = err.description;
  }
}

const build = () =>
  new FakeGrammyError(
    "Call to 'sendMessage' failed!",
    { error_code: 400, description: "x" },
    "sendMessage",
    { chat_id: 1, text: "SECRET" },
  );

describe("safeErr", () => {
  it("drops the Telegram request payload but keeps diagnostic fields", () => {
    const json = JSON.stringify(safeErr(build()));
    expect(json).not.toContain("SECRET");
    expect(json).toContain("Call to 'sendMessage' failed!");
    expect(json).toContain("sendMessage");
    expect(json).toContain("400");
    expect(json).toContain('"description":"x"');
  });

  it("redacts a payload nested under a wrapper's error property", () => {
    const wrapper = Object.assign(new Error("BotError"), { error: build() });
    expect(JSON.stringify(safeErr(wrapper))).not.toContain("SECRET");
  });

  it("redacts a payload reachable through a cause chain", () => {
    const outer = new Error("outer", { cause: build() });
    const outer2 = new Error("outer2", { cause: outer });
    expect(JSON.stringify(safeErr(outer2))).not.toContain("SECRET");
  });

  it("does not mutate the original error", () => {
    const e = build();
    safeErr(e);
    expect(e.payload).toEqual({ chat_id: 1, text: "SECRET" });
  });

  it("passes non-error values through", () => {
    expect(safeErr("plain")).toBe("plain");
  });
});

describe("createLogger", () => {
  it("never writes the payload of a logged error to the output line", () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger(dest);
    log.error({ err: build() }, "Telegram send failed");
    log.error({ err: Object.assign(new Error("w"), { error: build() }) }, "wrapped");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).not.toContain("SECRET");
    expect(lines[0]).toContain("Telegram send failed");
    expect(lines[0]).toContain("sendMessage");
  });
});
