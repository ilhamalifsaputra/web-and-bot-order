import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardRow } from "./CardRow";

describe("CardRow", () => {
  it("renders the label and value", () => {
    render(<CardRow label="Telegram ID" value="123456" />);
    expect(screen.getByText("Telegram ID")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
  });

  it("accepts a ReactNode as the value", () => {
    render(<CardRow label="Role" value={<span data-testid="role-value">Admin</span>} />);
    expect(screen.getByTestId("role-value")).toBeInTheDocument();
  });

  it("wraps a long unbroken value instead of overflowing, and keeps the label from shrinking", () => {
    const longEmail = "a-very-long-unbroken-customer-email-address-for-testing@example-subdomain.com";
    render(<CardRow label="Email" value={longEmail} />);
    const valueNode = screen.getByText(longEmail);
    expect(valueNode).toHaveClass("break-words");
    expect(valueNode).toHaveClass("min-w-0");
    const labelNode = screen.getByText("Email");
    expect(labelNode).toHaveClass("shrink-0");
  });
});
