import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LoadingState from "./LoadingState";

describe("LoadingState", () => {
  it("announces itself with aria-busy + a localised label", () => {
    render(<LoadingState />);
    const region = screen.getByLabelText("Loading…");
    expect(region).toHaveAttribute("aria-busy", "true");
  });

  it("accepts a label override", () => {
    render(<LoadingState label="Loading your orders…" />);
    expect(screen.getByLabelText("Loading your orders…")).toHaveAttribute("aria-busy", "true");
  });

  it("renders a skeleton silhouette, never a bare spinner", () => {
    const { container } = render(<LoadingState />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("each variant renders a distinct shape", () => {
    const { container: page } = render(<LoadingState variant="page" />);
    const { container: list } = render(<LoadingState variant="list" />);
    const { container: detail } = render(<LoadingState variant="detail" />);
    const { container: form } = render(<LoadingState variant="form" />);

    // list: five equal rows
    expect(list.querySelectorAll(".h-16").length).toBe(5);
    // detail: a media block beside the copy column
    expect(detail.querySelector(".aspect-square")).toBeInTheDocument();
    // form: a constrained column with labelled field rows
    expect(form.querySelector(".max-w-md")).toBeInTheDocument();
    // page: a title bar + text lines + one large block, and no media/list/form markers
    expect(page.querySelector(".aspect-square")).not.toBeInTheDocument();
    expect(page.querySelector(".max-w-md")).not.toBeInTheDocument();
    expect(page.querySelectorAll(".h-16").length).toBe(0);
    expect(page.querySelector(".h-64")).toBeInTheDocument();
  });
});
