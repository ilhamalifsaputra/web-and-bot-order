import "./setup-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "@app/core/config";
import { displayShortDateTime } from "../src/dateDisplay";
import { parseStatusChange } from "../src/lib/ticketStatusChange";

// Pin the display timezone so expectations do not depend on the environment.
const originalTimezone = config.TIMEZONE;
beforeEach(() => {
  (config as { TIMEZONE: string }).TIMEZONE = "Asia/Jakarta";
});
afterEach(() => {
  (config as { TIMEZONE: string }).TIMEZONE = originalTimezone;
});

describe("displayShortDateTime", () => {
  it("returns null for null/undefined", () => {
    expect(displayShortDateTime(null)).toBeNull();
    expect(displayShortDateTime(undefined)).toBeNull();
  });

  it("shows exactly HH:mm (no date) when on the same calendar day in TIMEZONE", () => {
    const now = new Date("2026-10-07T12:00:00Z"); // 19:00 Oct 7 in Asia/Jakarta
    expect(displayShortDateTime(new Date("2026-10-07T11:30:00Z"), now)).toBe("18:30");
  });

  it("shows 'LLL d, HH:mm' for a different day", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(displayShortDateTime(new Date("2026-10-05T12:00:00Z"), now)).toBe("Oct 5, 19:00");
  });

  it("compares calendar days in TIMEZONE, not in UTC", () => {
    const now = new Date("2026-10-07T17:00:30Z"); // 00:00:30 on Oct 8 in Asia/Jakarta
    // Same UTC day as `now`, but Oct 7 in Jakarta vs Oct 8: date prefix required.
    expect(displayShortDateTime(new Date("2026-10-07T16:59:30Z"), now)).toBe("Oct 7, 23:59");
    // Previous Jakarta day relative to a later `now`: date prefix.
    expect(displayShortDateTime(new Date("2026-10-07T16:30:00Z"), new Date("2026-10-07T20:00:00Z"))).toBe("Oct 7, 23:30");
    expect(displayShortDateTime(new Date("2026-10-07T17:10:00Z"), now)).toBe("00:10");
  });
});

describe("parseStatusChange", () => {
  it("parses the plain format", () => {
    expect(parseStatusChange("Ticket #34 moved from OPEN to WAITING_CUSTOMER.")).toEqual({
      from: "OPEN",
      to: "WAITING_CUSTOMER",
    });
  });

  it("parses the format with a trailing meta clause", () => {
    expect(parseStatusChange("Ticket #34 moved from WAITING_CUSTOMER to WAITING_ADMIN (customer replied).")).toEqual({
      from: "WAITING_CUSTOMER",
      to: "WAITING_ADMIN",
    });
  });

  it("returns null when unparseable or empty", () => {
    expect(parseStatusChange("Replied to ticket #34.")).toBeNull();
    expect(parseStatusChange("")).toBeNull();
    expect(parseStatusChange(null)).toBeNull();
  });
});
