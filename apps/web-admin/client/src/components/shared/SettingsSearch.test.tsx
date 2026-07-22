import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { highlightMatch, matchesQuery } from "./SettingsSearch";

describe("matchesQuery", () => {
  it("matches case-insensitively", () => {
    expect(matchesQuery("Shop Name", "shop")).toBe(true);
    expect(matchesQuery("Shop Name", "NAME")).toBe(true);
  });

  it("returns true for an empty query", () => {
    expect(matchesQuery("Shop Name", "")).toBe(true);
    expect(matchesQuery("Shop Name", "   ")).toBe(true);
  });

  it("returns false when there's no match", () => {
    expect(matchesQuery("Shop Name", "telegram")).toBe(false);
  });
});

describe("highlightMatch", () => {
  it("wraps the matching substring in <mark>", () => {
    render(<div>{highlightMatch("Shop Name", "Name")}</div>);
    const mark = screen.getByText("Name", { selector: "mark" });
    expect(mark).toBeInTheDocument();
  });

  it("renders the text unchanged when the query is empty", () => {
    render(<div>{highlightMatch("Shop Name", "")}</div>);
    expect(screen.getByText("Shop Name")).toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();
  });

  it("highlights every occurrence, case-insensitively", () => {
    render(<div>{highlightMatch("BOT bot Bot", "bot")}</div>);
    expect(document.querySelectorAll("mark")).toHaveLength(3);
  });
});
