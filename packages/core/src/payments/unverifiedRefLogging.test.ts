/**
 * Backend audit, Task B3e: a callback whose signature does not verify is
 * attacker-controlled bytes. Its reference id must not be written raw into
 * the log — it can carry newlines (forged log lines), control characters or
 * kilobytes of junk. The three gateway verifiers log the rejection without it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../logger";
import { verifyCallback as verifyTokopay } from "./tokopay";
import { verifyCallback as verifyPaydisini } from "./paydisini";
import { verifyCallback as verifyDigiflazz } from "../suppliers/digiflazz";

const EVIL_REF = `ORD-1\n{"level":30,"msg":"INJECTED fake log line"}\u001b[31m${"x".repeat(2000)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

const cases: Array<[string, () => unknown]> = [
  ["TokoPay", () => verifyTokopay({ ref_id: EVIL_REF, signature: "deadbeef" }, { merchantId: "M", secret: "S" })],
  ["PayDisini", () => verifyPaydisini({ ref_id: EVIL_REF, amount: "1000", signature: "deadbeef" }, { userKey: "U", apiKey: "A" })],
  ["Digiflazz", () => verifyDigiflazz("secret", { ref_id: EVIL_REF, signature: "deadbeef" })],
];

describe.each(cases)("%s verifyCallback with a bad signature (Task B3e)", (_name, run) => {
  it("rejects it and logs the rejection without the unverified reference", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(run()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain("INJECTED");
    expect(logged).not.toContain("xxxxxxxxxx");
    expect(logged).not.toContain("\\n{");
  });
});
