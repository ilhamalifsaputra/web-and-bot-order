import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SaveConfirmDialog } from "./SaveConfirmDialog";

function Harness({
  onConfirm,
  successMessage,
}: {
  onConfirm: () => Promise<string | void>;
  successMessage?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <SaveConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Save this setting?"
      description="This updates the live setting immediately."
      onConfirm={onConfirm}
      successMessage={successMessage}
    />
  );
}

describe("SaveConfirmDialog", () => {
  it("ignores a save that completes after the dialog has been closed and reopened", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onOpenChange = vi.fn();
    const props = { onConfirm, onOpenChange, title: "Save this setting?" };
    const view = render(<SaveConfirmDialog {...props} open />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    view.rerender(<SaveConfirmDialog {...props} open={false} />);
    view.rerender(<SaveConfirmDialog {...props} open />);
    await act(async () => { finish(); });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText("Saved successfully")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("opens a fresh confirmation after an error was dismissed", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("network"));
    const props = { onConfirm, title: "Save this setting?", onOpenChange: vi.fn() };
    const view = render(<SaveConfirmDialog {...props} open />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("network")).toBeInTheDocument();
    view.rerender(<SaveConfirmDialog {...props} open={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    view.rerender(<SaveConfirmDialog {...props} open />);
    expect(screen.queryByText("network")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("ignores completion from a save whose dialog was externally unmounted", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { resolveConfirm = resolve; }));
    const onOpenChange = vi.fn();
    const props = { onConfirm, onOpenChange, title: "Save this setting?" };
    const view = render(<SaveConfirmDialog {...props} open />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<SaveConfirmDialog {...props} open={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    view.rerender(<SaveConfirmDialog {...props} open />);
    resolveConfirm();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.queryByText("Saved successfully")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirm -> saving -> success shows a checkmark and auto-closes", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} successMessage="Saved successfully" />);

    const user = userEvent.setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved successfully")).toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"), { timeout: 2000 });
  });

  it("shows a resolved message from onConfirm instead of the default successMessage", async () => {
    const onConfirm = vi.fn().mockResolvedValue("Rate updated to 15,800 (ok)");
    render(<Harness onConfirm={onConfirm} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Rate updated to 15,800 (ok)")).toBeInTheDocument();
  });

  it("confirm -> saving -> error keeps the dialog open and lets the user retry", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("Incorrect current password"))
      .mockResolvedValueOnce(undefined);
    render(<Harness onConfirm={onConfirm} successMessage="Saved successfully" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Incorrect current password")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Retry the same action — succeeds this time.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved successfully")).toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("lets the user cancel out of an error instead of retrying", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("network"));
    render(<Harness onConfirm={onConfirm} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("network")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("disables Cancel and Confirm while a save is in flight", async () => {
    let resolveConfirm: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(<Harness onConfirm={onConfirm} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveConfirm?.();
    await waitFor(() => expect(screen.getByText("Saved successfully")).toBeInTheDocument());
  });
});
