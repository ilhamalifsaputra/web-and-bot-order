import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketMessageThread from "./TicketMessageThread";
import type { TicketTimelineEntry } from "../../lib/ticketTimeline";
import { buildTicketTimeline } from "../../lib/ticketTimeline";

describe("TicketMessageThread", () => {
  it("preserves each duplicate message's video and playback position across insertion and reordering", () => {
    const ticket = { id: 7, message: "Opening", created_at_display: "2026-07-01 09:00", admin_reply: null, replied_at_display: null, closed_at_display: null, attachments: [] };
    const message = { from_user: true, content: "same", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/same.mp4"] };
    const { container, rerender } = render(<TicketMessageThread entries={buildTicketTimeline(ticket, [{ ...message, id: 101 }, { ...message, id: 102 }])} />);
    const first = container.querySelectorAll("video")[0]!;
    const second = container.querySelectorAll("video")[1]!;
    first.currentTime = 17;
    second.currentTime = 23;
    rerender(<TicketMessageThread entries={buildTicketTimeline(ticket, [
      { ...message, id: 103, created_at_display: "2026-07-01 09:01" },
      { ...message, id: 102 }, { ...message, id: 101 },
    ])} />);
    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(3);
    expect(videos[1]).toBe(second);
    expect(videos[2]).toBe(first);
    expect(videos[1]?.currentTime).toBe(23);
    expect(videos[2]?.currentTime).toBe(17);
  });

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
      { id: "fixture-1", kind: "system", key: "created", labelKey: "web.ticket_event_created", created_at_display: "2026-07-01 09:00" },
      { id: "fixture-2", kind: "message", from_user: true, content: "It broke", created_at_display: "2026-07-01 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(screen.getByText("Ticket created")).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();
  });

  it("labels customer vs support messages distinctly", () => {
    const entries: TicketTimelineEntry[] = [
      { id: "fixture-3", kind: "message", from_user: true, content: "customer msg", created_at_display: "2026-07-01 09:00", attachments: [] },
      { id: "fixture-4", kind: "message", from_user: false, content: "support msg", created_at_display: "2026-07-01 09:05", attachments: [] },
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
      { id: "fixture-5", kind: "message", from_user: true, content: "msg 1", created_at_display: "2026-07-01 09:00", attachments: [] },
      { id: "fixture-6", kind: "message", from_user: true, content: "msg 2", created_at_display: "2026-07-01 09:05", attachments: [] },
      { id: "fixture-7", kind: "message", from_user: true, content: "msg 3", created_at_display: "2026-07-02 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    // Two distinct dates → two divider labels rendered as the raw date string
    // (neither matches today/yesterday relative to the test run date).
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getByText("2026-07-02")).toBeInTheDocument();
  });

  it("renders attachments via AttachmentGallery", () => {
    const entries: TicketTimelineEntry[] = [
      { id: "fixture-8", kind: "message", from_user: true, content: "evidence", created_at_display: "2026-07-01 09:00", attachments: ["/uploads/tickets/a.png"] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(document.querySelector('img[src="/uploads/tickets/a.png"]')).toBeInTheDocument();
  });

  // R5 (Task 1): whitespace-pre-line was already here, but without
  // break-words a long unbroken token (e.g. a URL pasted as proof) overflows
  // its bubble. The parent has overflow-hidden, so the page doesn't shift --
  // the text just gets clipped and unreadable.
  it("preserves message text and wraps long tokens at any character", () => {
    const longToken = "https://proof.example.com/" + "a".repeat(80);
    const entries: TicketTimelineEntry[] = [
      { id: "fixture-9", kind: "message", from_user: true, content: `line one\n\n${longToken}`, created_at_display: "2026-07-01 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    const messageParagraph = document.querySelector("p.text-sm.whitespace-pre-line");
    expect(messageParagraph).not.toBeNull();
    expect(messageParagraph?.textContent).toBe(`line one\n\n${longToken}`);
    expect(messageParagraph).toHaveClass("[overflow-wrap:anywhere]");
  });
});
