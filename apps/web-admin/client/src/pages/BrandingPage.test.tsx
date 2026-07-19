import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("displays dimension hints for all image upload fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(BRANDING_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Recommended: 512x512px/)).toBeInTheDocument(); // Favicon
      expect(screen.getByText(/Recommended: 400x200px/)).toBeInTheDocument(); // Logo
      expect(screen.getAllByText(/Recommended: 1200x400px/)).toHaveLength(2); // Hero + Banner
    });
  });

  it("saving a text field opens a confirmation dialog and shows a checkmark on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(BRANDING_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("My Test Shop")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const input = screen.getByDisplayValue("My Test Shop");
    await user.clear(input);
    await user.type(input, "Renamed Shop");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Save "Shop name"?')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(BRANDING_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved successfully")).toBeInTheDocument();
  });

  it("removing the banner opens a confirmation dialog and shows a checkmark on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...BRANDING_DATA, bannerUrl: "/uploads/branding/banner.png" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<BrandingPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("My Test Shop")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove banner" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove banner?")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(BRANDING_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Banner removed")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/branding/banner/clear",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
