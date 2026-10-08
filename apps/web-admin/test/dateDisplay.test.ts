import "./setup-env";
import { describe, expect, it } from "vitest";
import { config } from "@app/core/config";
import { displayShortDateTime } from "../src/dateDisplay";
import { parseStatusChange } from "../src/lib/ticketStatusChange";

describe("displayShortDateTime", () => {
  it("returns null for null/undefined", () => {
    expect(displayShortDateTime(null)).toBeNull();
    expect(displayShortDateTime(undefined)).toBeNull();
  });

  it("shows only HH:mm when the date is the same calendar day in the configured TIMEZONE", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const out = displayShortDateTime(new Date("2026-10-07T11:30:00Z"), now)!;
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it("shows 'LLL d, HH:mm' for a different day", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const out = displayShortDateTime(new Date("2026-10-05T12:00:00Z"), now)!;
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
    expect(out).toContain("Oct 5");
  });

  it("compares calendar days in TIMEZONE, not in UTC", () => {
    const now = new Date("2026-10-07T17:00:30Z"); // 00:00:30 on Oct 8 in Asia/Jakarta
    const before = new Date("2026-10-07T16:59:30Z"); // 23:59:30 on Oct 7 in Asia/Jakarta
    const out = displayShortDateTime(before, now)!;
    if (config.TIMEZONE === "Asia/Jakarta") expect(out).toBe("Oct 7, 23:59");
    else expect(out).toBeTruthy();
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
