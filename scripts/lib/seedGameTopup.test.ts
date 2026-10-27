import { describe, expect, it } from "vitest";
import { assertSeedTarget, parseSeedArgs, SEED_DB_NAME } from "./seedGameTopup";

const OK = `postgresql://u:p@localhost:5433/${SEED_DB_NAME}`;
const flags = { confirmWorktreeDb: true };

describe("assertSeedTarget", () => {
  it("accepts a local host with the worktree database and the confirm flag", () => {
    expect(() => assertSeedTarget(OK, flags)).not.toThrow();
    expect(() => assertSeedTarget(`postgresql://u:p@127.0.0.1:5433/${SEED_DB_NAME}?schema=public`, flags)).not.toThrow();
    expect(() => assertSeedTarget(`postgresql://u:p@[::1]:5433/${SEED_DB_NAME}`, flags)).not.toThrow();
  });
  it("refuses a non-local host, a wrong database name, a missing flag and an unusable URL", () => {
    expect(() => assertSeedTarget(`postgresql://u:p@db.example.com:5432/${SEED_DB_NAME}`, flags)).toThrow(/host/);
    expect(() => assertSeedTarget("postgresql://u:p@localhost:5433/bot_order", flags)).toThrow(/bot_order_gtr/);
    expect(() => assertSeedTarget("postgresql://u:p@localhost:5433/bot_order_gtr_x", flags)).toThrow(/bot_order_gtr/);
    expect(() => assertSeedTarget(OK, { confirmWorktreeDb: false })).toThrow(/--confirm-worktree-db/);
    expect(() => assertSeedTarget(undefined, flags)).toThrow(/DATABASE_URL_PRISMA/);
    expect(() => assertSeedTarget("not a url", flags)).toThrow();
  });
  it("never echoes the URL or its credentials in the error", () => {
    try {
      assertSeedTarget("postgresql://admin:s3cret@db.example.com:5432/other", flags);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret");
      expect((e as Error).message).not.toContain("postgresql://");
    }
  });
});

describe("parseSeedArgs", () => {
  it("reads --bulk alone, with --apply and with --remove", () => {
    expect(parseSeedArgs(["--confirm-worktree-db", "--bulk"])).toMatchObject({ bulk: true, apply: false, remove: false, unknown: undefined });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply", "--bulk"])).toMatchObject({ bulk: true, apply: true, remove: false });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply", "--remove", "--bulk"])).toMatchObject({ bulk: true, apply: true, remove: true });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply"]).bulk).toBe(false);
  });
  it("still flags unknown options and recognises help", () => {
    expect(parseSeedArgs(["--bulks"]).unknown).toBe("--bulks");
    expect(parseSeedArgs(["--help"])).toMatchObject({ help: true, unknown: undefined });
    expect(parseSeedArgs(["-h"]).help).toBe(true);
  });
});

describe("assertSeedTarget query-string host overrides", () => {
  it.each([
    "?host=db.prod.example.com",
    "?hostaddr=203.0.113.9",
    "?host=/var/run/postgresql",
    "?schema=public&host=db.prod.example.com",
    "?HOST=db.prod.example.com",
  ])("refuses %s without echoing the URL", (query) => {
    const url = `postgresql://u:s3cret@localhost:5433/${SEED_DB_NAME}${query}`;
    try {
      assertSeedTarget(url, flags);
      throw new Error("should have refused");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/host/);
      expect(msg).not.toContain("s3cret");
      expect(msg).not.toContain("example.com");
      expect(msg).not.toContain("postgresql://");
    }
  });
  it("still accepts a plain schema parameter", () => {
    expect(() => assertSeedTarget(`${OK}?schema=public`, flags)).not.toThrow();
  });
});

