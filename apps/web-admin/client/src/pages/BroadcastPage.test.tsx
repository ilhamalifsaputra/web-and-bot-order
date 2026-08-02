import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { BroadcastPage } from "./BroadcastPage";
import { FakeXHR } from "@/test/fakeXhr";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// Shape matches what GET /api/broadcast actually sends (see broadcast.ts's
// historyShaped) — total/sent, not the raw Prisma totalCount/sentCount, and
// no scheduledAt/createdAt since the page only ever renders scheduledAtDisplay.
const BROADCAST = { id: 1, message: "Hello customers!", segment: "ALL", status: "SENT", total: 200, sent: 12, scheduledAtDisplay: null, webImageUrl: null, failureReason: null };

beforeEach(() => {
  vi.restoreAllMocks();
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  // Radix Select uses pointer-capture APIs jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BroadcastPage", () => {
  it("renders broadcast history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL", "ACTIVE"], counts: { ALL: 200 }, history: [BROADCAST] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Hello customers!/)).toBeInTheDocument());
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
    // Regression guard for the totalCount/sentCount vs total/sent naming bug:
    // the Sent column must render real numbers, not "undefined/undefined".
    expect(screen.getByText("12/200")).toBeInTheDocument();
    expect(screen.getByText("immediate")).toBeInTheDocument(); // null scheduledAtDisplay fallback
  });

  it("shows the server-formatted schedule time for a scheduled broadcast", async () => {
    const scheduled = { ...BROADCAST, id: 3, status: "PENDING", scheduledAtDisplay: "2026-07-01 10:00" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [scheduled] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("2026-07-01 10:00")).toBeInTheDocument());
  });

  it("shows empty state when no history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: [], counts: {}, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows a thumbnail for a history row with an image, and a dash otherwise", async () => {
    const withImage = { ...BROADCAST, id: 2, message: "Gift promo!", webImageUrl: "/uploads/broadcasts/broadcast-abc.jpg" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [BROADCAST, withImage] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const { container } = render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Gift promo!/)).toBeInTheDocument());
    expect(screen.getByText("—")).toBeInTheDocument();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain("/uploads/broadcasts/broadcast-abc.jpg");
  });

  it("shows a live char counter that adapts to the 1024-char caption cap once an image is attached", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText("Write your broadcast message...");
    await user.type(textarea, "hi");
    expect(screen.getByText("2 / 4000")).toBeInTheDocument();

    const longMessage = "a".repeat(1025);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.jpg", { type: "image/jpeg" });
    await user.upload(fileInput, file);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]!.respond(200, JSON.stringify({ url: "/uploads/broadcasts/broadcast-xyz.jpg" }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Caption \(max 1024/)).toBeInTheDocument());

    fireEvent.change(textarea, { target: { value: longMessage } });
    await waitFor(() => expect(screen.getByText(/too long for a photo caption/)).toBeInTheDocument());
    const sendButton = screen.getByRole("button", { name: /send broadcast/i });
    expect(sendButton).toBeDisabled();
  });

  it("saves a draft without opening a confirm dialog, then resets the form", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 10 }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText("Write your broadcast message...") as HTMLTextAreaElement;
    await user.type(textarea, "Draft message");

    const segmentTrigger = screen.getByRole("combobox");
    await user.click(segmentTrigger);
    await user.click(await screen.findByRole("option", { name: /ALL/ }));

    await user.click(screen.getByRole("button", { name: "Save Draft" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/broadcast",
        expect.objectContaining({ method: "POST", body: expect.stringContaining('"draft":true') }),
      ),
    );
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(await screen.findByText("Draft saved.")).toBeInTheDocument();
  });

  it("sends a draft row now via the kebab menu after confirming", async () => {
    const draftRow = { ...BROADCAST, id: 5, status: "DRAFT", scheduledAtDisplay: null };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [draftRow] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Hello customers!/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /actions for broadcast 5/i }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Send Now"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Send this broadcast now?")).toBeInTheDocument();
    // Regression guard: the recipient count in this dialog reads from the
    // same row object as the Sent column, so it used to say "undefined
    // recipient(s)" too.
    expect(within(dialog).getByText(/to 200 recipient\(s\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send Now" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/broadcast/5/queue",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("Broadcast queued to send.")).toBeInTheDocument();
  });

  it("deletes a draft row via the kebab menu after confirming", async () => {
    const draftRow = { ...BROADCAST, id: 5, status: "DRAFT", scheduledAtDisplay: null };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [draftRow] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Hello customers!/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /actions for broadcast 5/i }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Delete draft"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this draft?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete draft" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/broadcast/5/delete",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("Draft deleted.")).toBeInTheDocument();
  });

  it("inserts a quick template into the message field, replacing any previous content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText("Write your broadcast message...") as HTMLTextAreaElement;
    await user.click(screen.getByRole("button", { name: "Restock" }));
    expect(textarea.value).toBe(
      "Good news! [Product name] is back in stock. Grab yours before it sells out again — order now!",
    );

    await user.type(textarea, " extra");
    await user.click(screen.getByRole("button", { name: "Maintenance" }));
    expect(textarea.value).toBe(
      "We'll be performing scheduled maintenance on [date/time]. The bot/site may be briefly unavailable. Thanks for your patience!",
    );
  });

  it("shows the failure reason as subtext under a Failed status badge", async () => {
    const failedRow = {
      ...BROADCAST,
      id: 6,
      status: "FAILED",
      failureReason: "The sender process restarted mid-broadcast; no further recipients were contacted.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [failedRow] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(screen.getByText(/sender process restarted/i)).toBeInTheDocument();
  });

  it("live-updates the Telegram-style preview as the message is typed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL"], counts: { ALL: 200 }, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const user = userEvent.setup();
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());

    expect(screen.getByText(/your message preview will appear here/i)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("Write your broadcast message...");
    await user.type(textarea, "Preview me");

    expect(screen.getAllByText("Preview me").length).toBeGreaterThan(0);
    expect(screen.queryByText(/your message preview will appear here/i)).not.toBeInTheDocument();
  });
});
