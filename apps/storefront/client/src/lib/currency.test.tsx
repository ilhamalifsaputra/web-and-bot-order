import { useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCurrencySwitch } from "./currency";
import "@testing-library/jest-dom";

let preference = "IDR";
vi.mock("../api/client", () => ({ apiPost: vi.fn(async (_path: string, body: { currency: string }) => { preference = body.currency; return body; }) }));

function Catalog() {
  const [failure, setFailure] = useState(false);
  const product = useQuery({ queryKey: ["product", "fixture"], queryFn: async () => `${preference} exact server price`, staleTime: Infinity });
  const { setCurrency } = useCurrencySwitch({ onError: () => setFailure(true) });
  return <><span>{product.data}</span><button onClick={() => setCurrency("USD")}>USD</button><span>{String(failure)}</span></>;
}
describe("currency catalog refresh", () => {
  it("refetches personalized product payload when the saved preference changes", async () => {
    preference = "IDR";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Catalog /></QueryClientProvider>);
    expect(await screen.findByText("IDR exact server price")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "USD" }));
    expect(await screen.findByText("USD exact server price")).toBeInTheDocument();
  });
});
