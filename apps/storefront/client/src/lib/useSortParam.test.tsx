import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { useSortParam } from "./useSortParam";

function Probe({ allowCheapest }: { allowCheapest: boolean | undefined }) {
  const [sort, setSort] = useSortParam({ allowCheapest });
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <output data-testid="sort">{sort}</output>
      <output data-testid="search">{location.search}</output>
      <output data-testid="nav">{navigationType}</output>
      <button type="button" onClick={() => setSort("newest")}>newest</button>
      <button type="button" onClick={() => setSort("bestseller")}>bestseller</button>
    </>
  );
}

function renderProbe(search: string, allowCheapest: boolean | undefined) {
  return render(
    <MemoryRouter initialEntries={[`/g/x${search}`]}>
      <Probe allowCheapest={allowCheapest} />
    </MemoryRouter>,
  );
}

describe("useSortParam", () => {
  it("defaults to bestseller with no ?sort", () => {
    renderProbe("", true);
    expect(screen.getByTestId("sort")).toHaveTextContent("bestseller");
  });

  it("reads an allowed ?sort", () => {
    renderProbe("?sort=cheapest", true);
    expect(screen.getByTestId("sort")).toHaveTextContent("cheapest");
    expect(screen.getByTestId("search")).toHaveTextContent("?sort=cheapest");
  });

  it("sets a sort while keeping the other query params, and drops ?sort for bestseller", () => {
    renderProbe("?category=steam", true);
    fireEvent.click(screen.getByRole("button", { name: "newest" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?category=steam&sort=newest");
    expect(screen.getByTestId("nav")).toHaveTextContent("PUSH");
    fireEvent.click(screen.getByRole("button", { name: "bestseller" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?category=steam");
    expect(screen.getByTestId("search")).not.toHaveTextContent("sort");
  });

  it("replaces a disallowed ?sort=cheapest so the URL matches what is shown", () => {
    renderProbe("?category=ml&sort=cheapest", false);
    expect(screen.getByTestId("sort")).toHaveTextContent("bestseller");
    expect(screen.getByTestId("search")).toHaveTextContent("?category=ml");
    expect(screen.getByTestId("search")).not.toHaveTextContent("sort");
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
  });

  it("replaces a legacy ?sort=rating with nothing", () => {
    renderProbe("?sort=rating", true);
    expect(screen.getByTestId("sort")).toHaveTextContent("bestseller");
    expect(screen.getByTestId("search")).toHaveTextContent(/^$/);
  });

  it("leaves the URL alone while it is not yet known whether cheapest is offered", () => {
    renderProbe("?sort=cheapest", undefined);
    // Requested as typed: the server decides, and the page re-checks once it knows.
    expect(screen.getByTestId("sort")).toHaveTextContent("cheapest");
    expect(screen.getByTestId("search")).toHaveTextContent("?sort=cheapest");
    expect(screen.getByTestId("nav")).toHaveTextContent("POP");
  });
});
