import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders the title", () => {
    render(
      <MemoryRouter>
        <PageHeader title="Products" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Products")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Products"
          actions={<button>Add Product</button>}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Add Product")).toBeInTheDocument();
  });

  it("renders breadcrumbs when provided", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Products"
          breadcrumb={[{ label: "Home" }, { label: "Catalog" }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Catalog")).toBeInTheDocument();
  });

  it("title+actions wrapper has flex-col and sm:flex-row classes for mobile responsiveness", () => {
    render(
      <MemoryRouter>
        <PageHeader title="Products" actions={<button>Add</button>} />
      </MemoryRouter>,
    );
    const h1 = screen.getByText("Products");
    // h1 sits in its own title-group wrapper (grouped with an optional
    // description); the flex-col/sm:flex-row row wrapper is one level up.
    const wrapper = h1.parentElement?.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("flex-col");
    expect(wrapper?.className).toContain("sm:flex-row");
  });

  it("renders an optional description under the title", () => {
    render(
      <MemoryRouter>
        <PageHeader title="Products" description="Manage products, variants and categories." />
      </MemoryRouter>,
    );
    expect(screen.getByText("Manage products, variants and categories.")).toBeInTheDocument();
  });

  it("actions wrapper has flex-wrap class to allow wrapping on narrow viewports", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Products"
          actions={
            <>
              <button>Manage</button>
              <button>Import</button>
              <button>Add</button>
            </>
          }
        />
      </MemoryRouter>,
    );
    const buttons = screen.getAllByRole("button");
    const actionsWrapper = buttons[0].parentElement;
    expect(actionsWrapper).not.toBeNull();
    expect(actionsWrapper?.className).toContain("flex-wrap");
  });
});
