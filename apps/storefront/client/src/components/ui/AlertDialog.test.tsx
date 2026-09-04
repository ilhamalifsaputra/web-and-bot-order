import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AlertDialog from "./AlertDialog";

function setup(props: Partial<React.ComponentProps<typeof AlertDialog>> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <AlertDialog
      open
      onCancel={onCancel}
      onConfirm={onConfirm}
      title="Delete order?"
      description="This cannot be undone."
      confirmLabel="Delete"
      cancelLabel="Keep it"
      {...props}
    />,
  );
  return { onCancel, onConfirm };
}

describe("AlertDialog", () => {
  it("is a role=alertdialog", () => {
    setup();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("starts focus on the Cancel button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
  });

  it("Escape triggers cancel, not confirm", () => {
    const { onCancel, onConfirm } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking confirm calls onConfirm", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("tone='danger' renders the confirm button as the danger variant", () => {
    setup({ tone: "danger" });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn-danger");
  });

  it("tone='default' renders the confirm button as the primary variant", () => {
    setup();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn-primary");
  });

  it("confirmPending disables both buttons and shows a spinner in confirm", () => {
    setup({ tone: "danger", confirmPending: true });
    const confirm = screen.getByRole("button", { name: "Delete" });
    const cancel = screen.getByRole("button", { name: "Keep it" });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    // Spinner renders an aria-hidden spinning span inside the confirm button
    expect(confirm.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("has no header close button (actions row only)", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});
