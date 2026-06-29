import "@testing-library/jest-dom";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PageLayout } from "./PageLayout";

describe("PageLayout", () => {
  afterEach(() => {
    document.title = "";
  });

  it("renders children", () => {
    render(
      <MemoryRouter>
        <PageLayout title="Orders">
          <p>content</p>
        </PageLayout>
      </MemoryRouter>,
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("sets the document title", () => {
    render(
      <MemoryRouter>
        <PageLayout title="Orders">
          <p>hi</p>
        </PageLayout>
      </MemoryRouter>,
    );
    expect(document.title).toBe("Orders — Shop Admin");
  });
});
