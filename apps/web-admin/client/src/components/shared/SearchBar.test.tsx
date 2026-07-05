import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("renders the placeholder and current value", () => {
    render(<SearchBar value="socks" onChange={() => {}} placeholder="Search…" />);
    expect(screen.getByPlaceholderText("Search…")).toHaveValue("socks");
  });

  it("calls onChange with the new value on typing", () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} placeholder="Search…" />);
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledWith("hi");
  });
});
