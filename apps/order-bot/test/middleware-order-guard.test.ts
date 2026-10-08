import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads main.ts from disk and imports nothing database-related, so it can run
// in `pnpm test:guards` without provisioning a Postgres schema.
describe("order-bot middleware order", () => {
  it("main.ts wires requireCurrency after registeredUser, rateLimit, commerceGate and joinGate", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts"), "utf8");
    const at = (mw: string) => src.indexOf(`bot.use(${mw});`);
    for (const mw of ["registeredUser", "rateLimit", "commerceGate", "joinGate", "requireCurrency"]) {
      expect(at(mw), `${mw} is wired`).toBeGreaterThan(-1);
    }
    expect(at("requireCurrency")).toBeGreaterThan(at("joinGate"));
    expect(at("joinGate")).toBeGreaterThan(at("rateLimit"));
    expect(at("rateLimit")).toBeGreaterThan(at("registeredUser"));
  });
});
