import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { jumpToHomeAnchor, onHomeAnchorClick, useHomeAnchorOnLoad } from "./homeAnchors";

const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;

function Page({ ready }: { ready: boolean }) {
  useHomeAnchorOnLoad(ready);
  return (
    <>
      <a href="#g-games" onClick={(e) => onHomeAnchorClick(e, "g-games")}>
        Games
      </a>
      <section id="g-games">games</section>
    </>
  );
}

function renderAt(url: string, ready = true) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Page ready={ready} />
    </MemoryRouter>,
  );
}

describe("home anchors", () => {
  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState({ usr: null, key: "home1", idx: 0 }, "", "/");
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  describe("clicking a jump link", () => {
    it("scrolls to the section without leaving a #hash in the history entry", () => {
      const push = vi.spyOn(window.history, "pushState");
      renderAt("/");
      const link = screen.getByRole("link", { name: "Games" });
      expect(link).toHaveAttribute("href", "#g-games");
      const notPrevented = fireEvent.click(link);
      expect(notPrevented).toBe(false); // preventDefault: no fragment navigation, no new history entry
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("g-games"));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      expect(window.location.hash).toBe("");
      expect(push).not.toHaveBeenCalled();
      push.mockRestore();
    });

    it("jumps instantly under reduced motion", () => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }));
      renderAt("/");
      fireEvent.click(screen.getByRole("link", { name: "Games" }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    });

    it("strips a #hash the URL already carries, keeping the router's history state", () => {
      window.history.replaceState({ usr: null, key: "home1", idx: 0 }, "", "/#g-old");
      renderAt("/");
      fireEvent.click(screen.getByRole("link", { name: "Games" }));
      expect(window.location.hash).toBe("");
      expect(window.location.pathname).toBe("/");
      expect(window.history.state).toEqual({ usr: null, key: "home1", idx: 0 });
    });

    it("leaves modified clicks (new tab / window) to the browser", () => {
      renderAt("/");
      const link = screen.getByRole("link", { name: "Games" });
      for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
        expect(fireEvent.click(link, mod)).toBe(true);
      }
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("falls back to the native jump when the target is not on the page", () => {
      render(
        <MemoryRouter>
          <a href="#g-missing" onClick={(e) => onHomeAnchorClick(e, "g-missing")}>
            Missing
          </a>
        </MemoryRouter>,
      );
      expect(fireEvent.click(screen.getByRole("link", { name: "Missing" }))).toBe(true);
    });
  });

  describe("a typed or shared /#g-... URL", () => {
    it("jumps to the anchor once the page is ready, then drops the hash so Back restores normally", () => {
      window.history.replaceState(null, "", "/#g-games");
      const { rerender } = renderAt("/#g-games", false);
      expect(scrollIntoView).not.toHaveBeenCalled();
      rerender(
        <MemoryRouter initialEntries={["/#g-games"]}>
          <Page ready />
        </MemoryRouter>,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
      expect(window.location.hash).toBe("");
    });

    it("does nothing without a hash (Back to / keeps the browser's own restoration)", () => {
      renderAt("/");
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("ignores a hash that names nothing on the page", () => {
      window.history.replaceState(null, "", "/#nope");
      renderAt("/#nope");
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("#nope");
    });
  });

  it("jumpToHomeAnchor reports whether it found the target", () => {
    renderAt("/");
    expect(jumpToHomeAnchor("g-games", "auto")).toBe(true);
    expect(jumpToHomeAnchor("g-none", "auto")).toBe(false);
  });
});
