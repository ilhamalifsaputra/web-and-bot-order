import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import FormField from "./FormField";
import Input from "./Input";

describe("FormField", () => {
  it("associates the label with the control via a generated id", () => {
    render(
      <FormField label="Email">
        <Input placeholder="you@example.com" />
      </FormField>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toBe(screen.getByPlaceholderText("you@example.com"));
    expect(input.id).toBeTruthy();
  });

  it("wires aria-describedby to the hint id", () => {
    render(
      <FormField label="Email" hint="We never share it." htmlFor="email">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-describedby", "email-hint");
    expect(screen.getByText("We never share it.")).toHaveAttribute("id", "email-hint");
  });

  it("on error: sets aria-invalid + invalid on the control and renders rust error text with the error id", () => {
    render(
      <FormField label="User ID" htmlFor="uid" error="Isi User ID kamu dulu ya.">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("User ID");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("!border-rust"); // `invalid` prop forwarded to <Input>
    expect(input).toHaveAttribute("aria-describedby", "uid-error");
    const err = screen.getByText("Isi User ID kamu dulu ya.");
    expect(err).toHaveAttribute("id", "uid-error");
    expect(err).toHaveClass("text-rust");
  });

  it("merges hint + error ids and keeps a caller-set aria-describedby", () => {
    render(
      <FormField label="X" htmlFor="x" hint="h" error="e">
        <Input aria-describedby="external" />
      </FormField>,
    );
    expect(screen.getByLabelText("X")).toHaveAttribute(
      "aria-describedby",
      "external x-hint x-error",
    );
  });

  it("renders the required marker on the label", () => {
    render(
      <FormField label="Email" required htmlFor="email">
        <Input />
      </FormField>,
    );
    expect(screen.getByText("(required)", { exact: false })).toHaveClass("sr-only");
  });
});
