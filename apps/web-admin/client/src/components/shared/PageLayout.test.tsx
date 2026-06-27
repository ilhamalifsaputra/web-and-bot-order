import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PageLayout } from "./PageLayout";

describe("PageLayout", () => {
  it("renders the page title and navigation links", () => {
    render(
      <MemoryRouter>
        <PageLayout title="Orders">
          <p>content</p>
        </PageLayout>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /catalog/i })).toHaveAttribute("href", "/catalog");
    expect(screen.getByRole("link", { name: /logout/i })).toHaveAttribute("href", "/logout");
  });

  it("marks the active nav link", () => {
    render(
      <MemoryRouter initialEntries={["/orders"]}>
        <PageLayout title="Orders">
          <p>hi</p>
        </PageLayout>
      </MemoryRouter>,
    );
    const ordersLink = screen.getByRole("link", { name: /^orders$/i });
    expect(ordersLink).toHaveAttribute("aria-current", "page");
  });
});
