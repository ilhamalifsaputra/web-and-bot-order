import "@testing-library/jest-dom";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
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
