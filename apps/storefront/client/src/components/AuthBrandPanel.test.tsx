import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AuthBrandPanel from "./AuthBrandPanel";
import { apiGet } from "../api/client";

vi.mock("../api/client", () => ({ apiGet: vi.fn() }));

function renderPanel() {
  (apiGet as Mock).mockResolvedValue({
    lang: "en",
    shop_name: "Toko Digital",
    logo_url: "",
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthBrandPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AuthBrandPanel", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the shared TrustBadgeRow with the four capability claims, stacked", async () => {
    renderPanel();
    expect(await screen.findByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByText("Warranty per plan")).toBeInTheDocument();
    expect(screen.getByText("Help via support ticket")).toBeInTheDocument();
    // The trust claims are a real list, laid out as a stack (orientation="column").
    const list = screen.getByText("Instant delivery").closest("ul")!;
    expect(list.className).toContain("space-y-3");
    expect(list.querySelectorAll("li")).toHaveLength(4);
  });

  it("keeps the policy links", async () => {
    renderPanel();
    expect(await screen.findByRole("link", { name: /Terms/i })).toBeInTheDocument();
  });
});
