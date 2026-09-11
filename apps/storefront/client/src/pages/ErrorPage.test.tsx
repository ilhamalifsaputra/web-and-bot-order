import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ErrorPage from "./ErrorPage";

describe("ErrorPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("defaults to 404 and composes NotFoundState, with a link home", () => {
    render(
      <MemoryRouter>
        <ErrorPage />
      </MemoryRouter>,
    );
    // §16: the status number is a quiet caption, never the headline.
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "404" })).not.toBeInTheDocument();
    // NotFoundState's copy + the passed-through default message.
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.getByText("That page doesn't exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("composes ErrorState for a 500 and shows a custom message", () => {
    render(
      <MemoryRouter>
        <ErrorPage statusCode={500} message="Something broke." />
      </MemoryRouter>,
    );
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Something broke.")).toBeInTheDocument();
  });

  it("defaults to the web.error_message copy for a 500 with no message override", () => {
    render(
      <MemoryRouter>
        <ErrorPage statusCode={500} />
      </MemoryRouter>,
    );
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });
});
