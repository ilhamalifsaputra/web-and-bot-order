import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { describe, it, expect, beforeEach } from "vitest";
import {
  loginRateLimited,
  accountLockedOut,
  recordAccountFailure,
  resetLoginAttempts,
  resetAccountFailures,
  MAX_LOGIN_LIMITER_BUCKETS,
  loginLimiterSizes,
} from "../src/auth";

describe("login limiters are memory-bounded", () => {
  beforeEach(() => {
    for (let i = 0; i < MAX_LOGIN_LIMITER_BUCKETS + 50; i++) {
      resetLoginAttempts(`flood-${i}`);
      resetAccountFailures(i + 1);
    }
  });

  it("caps the per-IP map: a flood of distinct IPs cannot grow it past the cap", () => {
    for (let i = 0; i < MAX_LOGIN_LIMITER_BUCKETS + 50; i++) loginRateLimited(`flood-${i}`);
    expect(loginLimiterSizes().ips).toBeLessThanOrEqual(MAX_LOGIN_LIMITER_BUCKETS);
    // Fail closed for a brand-new IP at capacity, like the storefront limiter.
    expect(loginRateLimited("flood-brand-new")).toBe(true);
    // An already-tracked IP keeps its normal sliding-window behaviour.
    expect(loginRateLimited("flood-0")).toBe(false);
  });

  it("caps the per-account map: a flood of distinct telegram ids cannot grow it past the cap", () => {
    for (let i = 0; i < MAX_LOGIN_LIMITER_BUCKETS + 50; i++) recordAccountFailure(i + 1);
    expect(loginLimiterSizes().accounts).toBeLessThanOrEqual(MAX_LOGIN_LIMITER_BUCKETS);
    expect(accountLockedOut(1)).toBe(false);
  });
});
