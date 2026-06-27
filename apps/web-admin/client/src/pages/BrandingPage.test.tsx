import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrandingPage } from "./BrandingPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const BRANDING_DATA = {
  faviconUrl: "/uploads/branding/favicon.png",
  logoUrl: "/uploads/branding/logo.png",
  heroUrl: "",
  bannerUrl: "",
  bannerIsLegacy: false,
  shopName: "My Test Shop",
  shopTagline: "Best deals around",
  welcome: "Welcome to our shop!",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BrandingPage", () => {
  it("shows shop name from branding data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(BRANDING_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("My Test Shop")).toBeInTheDocument());
    expect(screen.getByText("Best deals around")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/failed to load branding/i)).toBeInTheDocument(),
    );
  });

  it("shows no image set when image URLs are empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...BRANDING_DATA,
          faviconUrl: "",
          logoUrl: "",
          heroUrl: "",
          bannerUrl: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() => {
      const noImageMessages = screen.getAllByText(/no image set/i);
      expect(noImageMessages.length).toBeGreaterThan(0);
    });
  });
});
