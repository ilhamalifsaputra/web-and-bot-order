import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ErrorPage from "./ErrorPage";

describe("ErrorPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("defaults to 404 and the web.not_found copy, with a link home", () => {
    render(
      <MemoryRouter>
        <ErrorPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("That page doesn't exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("renders a custom status code and message when provided", () => {
    render(
      <MemoryRouter>
        <ErrorPage statusCode={500} message="Something broke." />
      </MemoryRouter>,
    );
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("Something broke.")).toBeInTheDocument();
  });
});
