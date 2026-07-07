import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BroadcastPage } from "./BroadcastPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const BROADCAST = { id: 1, message: "Hello customers!", segment: "ALL", status: "SENT", total: 100, sent: 100, scheduledAt: null, scheduledAtDisplay: null, createdAt: "2026-06-26T10:00:00.000Z", webImageUrl: null };

beforeEach(() => { vi.restoreAllMocks(); });

describe("BroadcastPage", () => {
  it("renders broadcast history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL", "ACTIVE"], counts: { ALL: 200 }, history: [BROADCAST] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Hello customers!/)).toBeInTheDocument());
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
    expect(screen.getByText("immediate")).toBeInTheDocument(); // null scheduledAtDisplay fallback
  });

  it("shows the server-formatted schedule time for a scheduled broadcast", async () => {
    const scheduled = { ...BROADCAST, id: 3, status: "PENDING", scheduledAt: "2026-07-01T03:00:00.000Z", scheduledAtDisplay: "2026-07-01 10:00" };
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

    const textarea = screen.getByPlaceholderText("Message (max 4000 chars)");
    await user.type(textarea, "hi");
    expect(screen.getByText("2 / 4000")).toBeInTheDocument();

    const longMessage = "a".repeat(1025);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "/uploads/broadcasts/broadcast-xyz.jpg" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.jpg", { type: "image/jpeg" });
    await user.upload(fileInput, file);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Caption \(max 1024/)).toBeInTheDocument());

    fireEvent.change(textarea, { target: { value: longMessage } });
    await waitFor(() => expect(screen.getByText(/too long for a photo caption/)).toBeInTheDocument());
    const sendButton = screen.getByRole("button", { name: /send now/i });
    expect(sendButton).toBeDisabled();
  });
});
