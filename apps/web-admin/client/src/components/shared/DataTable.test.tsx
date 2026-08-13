import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { DataTable } from "./DataTable";
import { Checkbox } from "@/components/ui/checkbox";

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
// false in this test environment (see its own comment) — this describe block
// only exercises the desktop <table> branch, which is where stickyHeader
// applies. The "DataTable mobile card stack" describe below stubs
// matchMedia so it can exercise the mobile branch instead.
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

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true, configurable: true,
    value: (query: string) => ({
      matches, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function makeSelectionColumn(render?: (row: Row) => ReactNode) {
  return {
    key: "select",
    header: <Checkbox aria-label="Select all rows" />,
    render: render ?? ((row: Row) => <Checkbox aria-label={`Select ${row.name}`} />),
    kind: "selection" as const,
  };
}

function getCards(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".rounded-lg.border.border-line.bg-card")
  );
}

describe("DataTable mobile card stack", () => {
  beforeEach(() => mockMatchMedia(true));
  afterEach(() => {
    delete (window as any).matchMedia;
  });

  it("renders exactly one checkbox per card", () => {
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    const { container } = render(
      <DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />
    );
    const cards = getCards(container);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(within(card).getAllByRole("checkbox")).toHaveLength(1);
    }
    expect(
      within(cards[0]).getByRole("checkbox", { name: "Select Alpha" })
    ).toBeInTheDocument();
    expect(
      within(cards[1]).getByRole("checkbox", { name: "Select Bravo" })
    ).toBeInTheDocument();
  });

  it("renders the select-all checkbox exactly once in the whole tree", () => {
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
    expect(screen.getAllByRole("checkbox", { name: "Select all rows" })).toHaveLength(1);
  });

  it("renders the select-all bar before the first card, showing the visible text", () => {
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    const { container } = render(
      <DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />
    );
    const bar = screen.getByText("Select all");
    const [firstCard] = getCards(container);
    // FOLLOWING alone is also true when the card is nested *inside* the bar, so
    // rule containment out too — otherwise wrapping the whole stack in the bar
    // would still pass.
    const position = bar.compareDocumentPosition(firstCard);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
  });

  it("keeps a header:'' action column as an action slot, not a checkbox or label/value row", () => {
    const actionColumn = { key: "edit", header: "", render: () => <button>Edit</button> };
    const columns = [COLUMNS[0], actionColumn];
    render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
    const buttons = screen.getAllByRole("button", { name: "Edit" });
    expect(buttons).toHaveLength(2);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    for (const button of buttons) {
      expect(button.parentElement?.parentElement).toHaveClass("justify-end");
    }
  });

  it("does not fire onRowClick from the row checkbox, but does from the card body", () => {
    const onRowClick = vi.fn();
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    const { container } = render(
      <DataTable
        columns={columns}
        data={ROWS}
        keyExtractor={(r) => r.id}
        onRowClick={onRowClick}
      />
    );
    const [firstCard] = getCards(container);
    fireEvent.click(within(firstCard).getByRole("checkbox", { name: "Select Alpha" }));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(within(firstCard).getByText("Alpha"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("renders no checkbox and no empty slot when the selection render returns null for a row", () => {
    const columns = [
      makeSelectionColumn((row) =>
        row.name === "Alpha" ? <Checkbox aria-label="Select Alpha" /> : null
      ),
      COLUMNS[0],
    ];
    const { container } = render(
      <DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />
    );
    const [alphaCard, bravoCard] = getCards(container);
    expect(
      within(alphaCard).getByRole("checkbox", { name: "Select Alpha" })
    ).toBeInTheDocument();
    expect(within(bravoCard).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(bravoCard.querySelector(".pb-2")).not.toBeInTheDocument();
  });

  it("hides the select-all bar while loading", () => {
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    render(
      <DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} isLoading />
    );
    expect(screen.queryByText("Select all")).not.toBeInTheDocument();
  });

  it("hides the select-all bar when data is empty", () => {
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    render(<DataTable columns={columns} data={[]} keyExtractor={(r) => r.id} />);
    expect(screen.queryByText("Select all")).not.toBeInTheDocument();
  });

  it("desktop regression: with matchMedia absent, the selection header stays in thead and cell order is unchanged", () => {
    delete (window as any).matchMedia;
    const columns = [makeSelectionColumn(), COLUMNS[0]];
    const { container } = render(
      <DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />
    );
    const headCells = container.querySelectorAll("thead th");
    expect(headCells).toHaveLength(2);
    expect(
      within(headCells[0] as HTMLElement).getByRole("checkbox", { name: "Select all rows" })
    ).toBeInTheDocument();
    const firstRowCells = container.querySelectorAll("tbody tr")[0]!.querySelectorAll("td");
    expect(firstRowCells).toHaveLength(2);
    expect(
      within(firstRowCells[0] as HTMLElement).getByRole("checkbox", { name: "Select Alpha" })
    ).toBeInTheDocument();
  });
});
