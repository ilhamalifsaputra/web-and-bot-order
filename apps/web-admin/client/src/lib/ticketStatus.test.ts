import { describe, it, expect } from "vitest";
import { ticketStatusLabel } from "./ticketStatus";

describe("ticketStatusLabel", () => {
  it("maps each status to its admin-facing label", () => {
    expect(ticketStatusLabel("OPEN")).toBe("New");
    expect(ticketStatusLabel("WAITING_ADMIN")).toBe("New");
    expect(ticketStatusLabel("IN_PROGRESS")).toBe("In progress");
    expect(ticketStatusLabel("REPLIED")).toBe("Waiting for customer");
    expect(ticketStatusLabel("WAITING_CUSTOMER")).toBe("Waiting for customer");
    expect(ticketStatusLabel("RESOLVED")).toBe("Resolved");
    expect(ticketStatusLabel("CLOSED")).toBe("Closed");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(ticketStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
