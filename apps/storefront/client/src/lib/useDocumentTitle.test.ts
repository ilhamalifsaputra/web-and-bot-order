import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDocumentTitle } from "./useDocumentTitle";

describe("useDocumentTitle", () => {
  it("writes the given title to document.title", () => {
    renderHook(() => useDocumentTitle("Cart — Toko Digital"));
    expect(document.title).toBe("Cart — Toko Digital");
  });

  it("updates document.title when the title changes across renders", () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "Cart — Toko Digital" },
    });
    expect(document.title).toBe("Cart — Toko Digital");
    rerender({ title: "Checkout — Toko Digital" });
    expect(document.title).toBe("Checkout — Toko Digital");
  });

  it("leaves document.title untouched when passed undefined", () => {
    document.title = "Existing Title";
    renderHook(() => useDocumentTitle(undefined));
    expect(document.title).toBe("Existing Title");
  });

  it("leaves document.title untouched when passed an empty string", () => {
    document.title = "Existing Title";
    renderHook(() => useDocumentTitle(""));
    expect(document.title).toBe("Existing Title");
  });
});
