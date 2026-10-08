import { describe, it, expect } from "vitest";
import { ticketStatusLabel } from "./ticketStatus";

describe("ticketStatusLabel", () => {
  it("maps each status to its admin-facing label", () => {
    expect(ticketStatusLabel("OPEN")).toBe("Open");
    expect(ticketStatusLabel("WAITING_ADMIN")).toBe("Waiting for admin");
    expect(ticketStatusLabel("REPLIED")).toBe("Waiting for customer");
    expect(ticketStatusLabel("WAITING_CUSTOMER")).toBe("Waiting for customer");
    expect(ticketStatusLabel("RESOLVED")).toBe("Resolved");
    expect(ticketStatusLabel("CLOSED")).toBe("Closed");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(ticketStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
