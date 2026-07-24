import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketMessageThread from "./TicketMessageThread";
import type { TicketTimelineEntry } from "../../lib/ticketTimeline";

describe("TicketMessageThread", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    // Fixed "now" so the Today/Yesterday grouping test (which asserts the
    // raw-date fallback for dates that are neither) can't flake depending on
    // what day the suite happens to run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a system event's label and a message's content", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "system", key: "created", labelKey: "web.ticket_event_created", created_at_display: "2026-07-01 09:00" },
      { kind: "message", from_user: true, content: "It broke", created_at_display: "2026-07-01 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(screen.getByText("Ticket created")).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();
  });

  it("labels customer vs support messages distinctly", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "customer msg", created_at_display: "2026-07-01 09:00", attachments: [] },
      { kind: "message", from_user: false, content: "support msg", created_at_display: "2026-07-01 09:05", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    // Sender label ("You"/"Support") appears once per bubble; the avatar next
    // to it shows only the first letter ("Y"/"S"), so it never collides with
    // these exact-text queries.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
  });

  it("renders one date divider per distinct date, not per entry", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "msg 1", created_at_display: "2026-07-01 09:00", attachments: [] },
      { kind: "message", from_user: true, content: "msg 2", created_at_display: "2026-07-01 09:05", attachments: [] },
      { kind: "message", from_user: true, content: "msg 3", created_at_display: "2026-07-02 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    // Two distinct dates → two divider labels rendered as the raw date string
    // (neither matches today/yesterday relative to the test run date).
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getByText("2026-07-02")).toBeInTheDocument();
  });

  it("renders attachments via AttachmentGallery", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "evidence", created_at_display: "2026-07-01 09:00", attachments: ["/uploads/tickets/a.png"] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(document.querySelector('img[src="/uploads/tickets/a.png"]')).toBeInTheDocument();
  });
});
