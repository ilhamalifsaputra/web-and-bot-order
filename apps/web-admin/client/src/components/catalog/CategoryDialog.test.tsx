import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CategoryDialog } from "./CategoryDialog";
import type { CategoryRow } from "../../api/catalog";

const CATEGORY: CategoryRow = {
  id: 7,
  name: "Apps",
  slug: "apps",
  emoji: "📱",
  description: "Mobile apps",
  sortOrder: 3,
  isActive: true,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("CategoryDialog", () => {
  it("creates a category with POST when no category is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ category: { id: 9 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(<CategoryDialog onClose={onClose} onSaved={onSaved} />);
    expect(screen.getByText("New category")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Games  " } });
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: "🎮" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.url).toBe("/api/catalog/categories");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ name: "Games", emoji: "🎮", description: null });
    expect(onClose).toHaveBeenCalled();
  });

  it("edits with PATCH and sends only the fields it shows, never the slug", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: "Applications" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByText("Edit category")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Applications" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.url).toBe("/api/catalog/categories/7");
    expect(req.method).toBe("PATCH");
    expect(req.body).toEqual({ name: "Applications", emoji: "📱", description: "Mobile apps" });
    expect(req.body).not.toHaveProperty("slug");
    expect(req.body).not.toHaveProperty("sortOrder");
  });

  it("shows the frozen web address while editing so a rename is not mistaken for a moved link", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText("/c/apps")).toBeInTheDocument();
  });

  it("keeps the save button disabled until a name is typed", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategoryDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Games" } });
    expect(create).toBeEnabled();
  });

  it("surfaces the server's message and leaves the dialog open when saving fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "A category named Games already exists." }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(<CategoryDialog onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Games" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("A category named Games already exists.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
