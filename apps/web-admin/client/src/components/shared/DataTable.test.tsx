import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DataTable } from "./DataTable";

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Bravo" },
];

const COLUMNS = [{ key: "name", header: "Name", render: (r: Row) => r.name }];

// jsdom has no matchMedia, so DataTable's useIsMobile() always resolves to
// false in this test environment (see its own comment) — these tests only
// exercise the desktop <table> branch, which is where stickyHeader applies.
describe("DataTable stickyHeader", () => {
  it("does not apply sticky positioning by default", () => {
    const { container } = render(
      <DataTable columns={COLUMNS} data={ROWS} keyExtractor={(r) => r.id} />
    );
    const header = container.querySelector("thead");
    expect(header).not.toHaveClass("sticky");
  });

  it("applies sticky positioning with an opaque background when stickyHeader is true", () => {
    const { container } = render(
      <DataTable columns={COLUMNS} data={ROWS} keyExtractor={(r) => r.id} stickyHeader />
    );
    const header = container.querySelector("thead");
    expect(header).toHaveClass("sticky");
    expect(header).toHaveClass("top-0");
    expect(header).toHaveClass("bg-card");
  });
});
