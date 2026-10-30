import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  checkoutFlow: "catalog",
  group: null,
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
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

async function pickGroup(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "Group" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("CategoryDialog", () => {
  it("explains that the Game Top-Up group always uses the top-up page", () => {
    render(<CategoryDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(
      screen.getByText(/Game Top-Up group always use the top-up page/),
    ).toBeInTheDocument();
  });

  it("creates a category with POST when no category is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ category: { id: 9 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(<CategoryDialog onClose={onClose} onSaved={onSaved} />);
    expect(screen.getByText("New category")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Games  " } });
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: "🎮" } });
    await pickGroup(user, "🎮 Game Top Up");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.url).toBe("/api/catalog/categories");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({
      name: "Games",
      emoji: "🎮",
      description: null,
      checkoutFlow: "catalog",
      group: "GAME_TOPUP",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("sends the selected group in the create POST body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ category: { id: 9 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onSaved = vi.fn();

    render(<CategoryDialog onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Games" } });

    await user.click(screen.getByRole("combobox", { name: "Group" }));
    await waitFor(() => screen.getByRole("option", { name: "🎮 Game Top Up" }));
    await user.click(screen.getByRole("option", { name: "🎮 Game Top Up" }));

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.body.group).toBe("GAME_TOPUP");
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
    expect(req.body).toEqual({
      name: "Applications",
      emoji: "📱",
      description: "Mobile apps",
      checkoutFlow: "catalog",
      group: null,
    });
    expect(req.body).not.toHaveProperty("slug");
    expect(req.body).not.toHaveProperty("sortOrder");
  });

  it("seeds the group select from the category being edited and re-sends it unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: "Apps" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(
      <CategoryDialog
        category={{ ...CATEGORY, group: "PREMIUM_APPS" }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Group" })).toHaveTextContent("💎 Premium Apps");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.body.group).toBe("PREMIUM_APPS");
  });

  it("seeds the checkout-flow radio from the category being edited and sends a changed value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: "Apps" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(
      <CategoryDialog
        category={{ ...CATEGORY, checkoutFlow: "instant" }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByRole("radio", { name: /^instant/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^catalog/i })).not.toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /^catalog/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = lastRequest(fetchMock);
    expect(req.body.checkoutFlow).toBe("catalog");
  });

  it("shows the frozen web address while editing so a rename is not mistaken for a moved link", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText("/c/apps")).toBeInTheDocument();
  });

  it("keeps Create disabled until both a name and a group are set", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CategoryDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Games" } });
    expect(create).toBeDisabled();

    await pickGroup(user, "💎 Premium Apps");
    expect(create).toBeEnabled();
  });

  it("keeps Save disabled while editing if the name is blanked", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategoryDialog category={{ ...CATEGORY, group: "PREMIUM_APPS" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers no 'Not set' option and no preselected group when creating", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CategoryDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    const select = screen.getByRole("combobox", { name: "Group" });
    expect(select).not.toHaveTextContent("Game Top Up");
    expect(select).not.toHaveTextContent("Premium Apps");
    await user.click(select);
    await screen.findByRole("option", { name: "🎮 Game Top Up" });
    expect(screen.queryByRole("option", { name: /Not set/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("explains what the group decides", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategoryDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(
      screen.getByText("Decides where this category appears on the website and in the bot."),
    ).toBeInTheDocument();
  });

  it("shows a legacy category's missing group as 'Not set (shown as Premium Apps)' and keeps sending null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: "Apps" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={onSaved} />);

    expect(screen.getByRole("combobox", { name: "Group" })).toHaveTextContent("Not set (shown as Premium Apps)");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastRequest(fetchMock).body.group).toBeNull();
  });

  it("stops offering 'Not set' for a legacy category once another group was picked", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("combobox", { name: "Group" }));
    expect(await screen.findByRole("option", { name: "Not set (shown as Premium Apps)" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "🎮 Game Top Up" }));

    await user.click(screen.getByRole("combobox", { name: "Group" }));
    await screen.findByRole("option", { name: "💎 Premium Apps" });
    expect(screen.queryByRole("option", { name: /Not set/ })).not.toBeInTheDocument();
  });

  it("offers no 'Not set' option when editing a category that has a group", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CategoryDialog category={{ ...CATEGORY, group: "GAME_TOPUP" }} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("combobox", { name: "Group" }));
    await screen.findByRole("option", { name: "💎 Premium Apps" });
    expect(screen.queryByRole("option", { name: /Not set/ })).not.toBeInTheDocument();
  });

  it("surfaces the server's message and leaves the dialog open when saving fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "A category named Games already exists." }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const onSaved = vi.fn();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CategoryDialog onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Games" } });
    await pickGroup(user, "🎮 Game Top Up");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("A category named Games already exists.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("CategoryDialog Telegram button hint", () => {
  it("shows the hint and a cell counter that makes room for the emoji, and warns without blocking Save", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ category: { id: 7 } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<CategoryDialog category={CATEGORY} onClose={vi.fn()} onSaved={onSaved} />);

    expect(screen.getByText(/Shown on the Telegram category button/)).toBeInTheDocument();
    // "Apps" = 4 cells; the category has an emoji, which takes 3 of the 18.
    expect(screen.getByTestId("button-label-counter")).toHaveTextContent("4/15");
    expect(screen.getByLabelText("Name").getAttribute("aria-describedby")).toBeTruthy();

    const long = "Mobile Legends Bang Bang Indonesia";
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: long } });
    expect(screen.getByTestId("button-label-counter")).toHaveAttribute("data-state", "over");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastRequest(fetchMock).body).toMatchObject({ name: long });

    // Clearing the emoji gives the full 18.
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: "" } });
    expect(screen.getByTestId("button-label-counter")).toHaveTextContent(`${long.length}/18`);
  });
});
