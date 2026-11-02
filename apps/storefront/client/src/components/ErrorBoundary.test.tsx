import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense } from "react";
import ErrorBoundary from "./ErrorBoundary";

/** jsdom here has no sessionStorage; install a minimal in-memory one. */
function installStorage(): Map<string, string> {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => entries.get(k) ?? null,
      setItem: (k: string, v: string) => { entries.set(k, v); },
      removeItem: (k: string) => { entries.delete(k); },
    },
  });
  return entries;
}

function Boom(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'map')");
}

describe("ErrorBoundary (H6)", () => {
  const reload = vi.fn();
  const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
  beforeEach(() => {
    document.documentElement.lang = "en";
    reload.mockReset();
    installStorage();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...window.location, reload } });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
    vi.restoreAllMocks();
  });

  it("catches a render throw, keeps what is outside it, and offers Reload", () => {
    render(
      <>
        <header>shop header</header>
        <ErrorBoundary resetKey="/cart"><Boom /></ErrorBoundary>
      </>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).toHaveTextContent("This page stopped working. Reloading usually fixes it.");
    expect(screen.getByText("shop header")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Reload page" }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears the error when the route changes", () => {
    const { rerender } = render(<ErrorBoundary resetKey="/cart"><Boom /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<ErrorBoundary resetKey="/products"><p>products page</p></ErrorBoundary>);
    expect(screen.getByText("products page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  function renderStaleChunk() {
    const Stale = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/CartPage-abc123.js")));
    return render(
      <ErrorBoundary resetKey="/cart">
        <Suspense fallback={<p>loading</p>}><Stale /></Suspense>
      </ErrorBoundary>,
    );
  }

  it("a rejected lazy import reloads the page once", async () => {
    renderStaleChunk();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a second stale chunk right after the reload shows the message instead of reloading again", async () => {
    const first = renderStaleChunk();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    first.unmount();
    // The reloaded page hits the same missing chunk.
    renderStaleChunk();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    await act(async () => {});
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
