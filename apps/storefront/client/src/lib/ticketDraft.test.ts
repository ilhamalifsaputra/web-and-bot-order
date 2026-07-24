import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadTicketDraft, saveTicketDraft, clearTicketDraft } from "./ticketDraft";

describe("ticketDraft", () => {
  // Mock localStorage for testing since jsdom may not provide it by default
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    // Clear mock storage
    Object.keys(mockStorage).forEach(key => delete mockStorage[key]);

    // Stub globalThis.localStorage if not available
    if (typeof globalThis.localStorage === "undefined") {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: (key: string) => mockStorage[key] ?? null,
          setItem: (key: string, value: string) => { mockStorage[key] = value; },
          removeItem: (key: string) => { delete mockStorage[key]; },
          clear: () => { Object.keys(mockStorage).forEach(key => delete mockStorage[key]); },
          key: (index: number) => Object.keys(mockStorage)[index] ?? null,
          length: Object.keys(mockStorage).length,
        },
        writable: true,
        configurable: true,
      });
    } else {
      localStorage.clear();
    }
  });

  it("round-trips a draft through save/load", () => {
    saveTicketDraft(7, "still working on this");
    expect(loadTicketDraft(7)).toBe("still working on this");
  });

  it("loadTicketDraft returns an empty string when nothing was saved", () => {
    expect(loadTicketDraft(999)).toBe("");
  });

  it("saving an empty/whitespace-only value clears any existing draft instead of storing blank", () => {
    saveTicketDraft(7, "something");
    saveTicketDraft(7, "   ");
    expect(loadTicketDraft(7)).toBe("");
  });

  it("clearTicketDraft removes a stored draft", () => {
    saveTicketDraft(7, "draft text");
    clearTicketDraft(7);
    expect(loadTicketDraft(7)).toBe("");
  });

  it("drafts for different ticket ids don't collide", () => {
    saveTicketDraft(1, "ticket one draft");
    saveTicketDraft(2, "ticket two draft");
    expect(loadTicketDraft(1)).toBe("ticket one draft");
    expect(loadTicketDraft(2)).toBe("ticket two draft");
  });
});
