import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupPendingPage from "./SetupPendingPage";

describe("SetupPendingPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows the shop-not-active copy", () => {
    render(<SetupPendingPage />);
    expect(screen.getByText("Shop not active yet")).toBeInTheDocument();
    expect(
      screen.getByText("The shop owner is still finishing setup in the admin panel. Please check back shortly."),
    ).toBeInTheDocument();
  });
});
