// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { describe, it, expect, vi } from "vitest";
import { guardRunnerTask } from "../src/main";

/**
 * `run(bot, ...)` from @grammyjs/runner starts its fetch loop in a detached
 * task (never awaited by the caller). If `bot.init()`/`getUpdates()` rejects
 * (e.g. an invalid bot_token), that rejection is otherwise unhandled and
 * crashes the whole process. guardRunnerTask() must catch it instead.
 */
describe("guardRunnerTask", () => {
  it("invokes onError when the task rejects, instead of leaving it unhandled", async () => {
    const onError = vi.fn();
    const task = Promise.reject(new Error("boom"));

    guardRunnerTask(task, onError);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("does nothing when the task is undefined", () => {
    const onError = vi.fn();
    expect(() => guardRunnerTask(undefined, onError)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });
});
