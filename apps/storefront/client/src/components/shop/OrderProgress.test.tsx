import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import OrderProgress from "./OrderProgress";
import type { OrderFulfillment } from "../../api/types";

function f(over: Partial<OrderFulfillment>): OrderFulfillment {
  return { mode: "AUTO", provider: "DIGIFLAZZ", status: "PROCESSING", payment_status: "PAID", can_edit_customer_data: false, ...over };
}
const list = () => screen.getByRole("list", { name: "Order progress" });

describe("OrderProgress", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the three steps in order", () => {
    render(<OrderProgress fulfillment={f({})} />);
    const items = within(list()).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Payment", "Processing", "Completed"]);
  });

  it.each(["QUEUED", "SUBMITTING", "PROCESSING"] as const)("spins and marks Processing current while %s", (status) => {
    const { container } = render(<OrderProgress fulfillment={f({ status })} />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(container.querySelector(".motion-reduce\\:animate-none")).toBeInTheDocument();
    expect(list().querySelector('[aria-current="step"]')).toHaveTextContent("Processing");
  });

  it("shows every step checked and no spinner when completed", () => {
    const { container } = render(<OrderProgress fulfillment={f({ status: "SUCCESS" })} />);
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(list().querySelector('[aria-current="step"]')).not.toBeInTheDocument();
    expect(list().querySelectorAll("li .bg-grass-tint")).toHaveLength(3);
  });

  it("shows the problem variant on the processing step when fulfillment failed", () => {
    const { container } = render(<OrderProgress fulfillment={f({ status: "FAILED" })} />);
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(list().querySelectorAll("li .bg-amberx-tint")).toHaveLength(1);
    expect(list().querySelectorAll("li .bg-grass-tint")).toHaveLength(1);
  });

  it("shows the review variant without a spinner for NEEDS_REVIEW", () => {
    const { container } = render(<OrderProgress fulfillment={f({ status: "NEEDS_REVIEW" })} />);
    expect(screen.getByRole("heading", { name: "We're checking your order" })).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("marks Payment as the pending step before payment", () => {
    render(<OrderProgress fulfillment={f({ status: "NOT_STARTED", payment_status: "PENDING" })} />);
    expect(list().querySelector('[aria-current="step"]')).toHaveTextContent("Payment");
  });

  it("shows a MANUAL order waiting on a static clock with Processing still current, never a spinner", () => {
    const { container } = render(<OrderProgress fulfillment={f({ mode: "MANUAL", provider: "MANUAL", status: "QUEUED" })} />);
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(list().querySelector('[aria-current="step"]')).toHaveTextContent("Processing");
  });

  it("uses neutral manual waiting copy without 'by hand' for a MANUAL order", () => {
    render(<OrderProgress fulfillment={f({ mode: "MANUAL", provider: "MANUAL", status: "QUEUED" })} />);
    expect(screen.getByRole("heading", { name: "Waiting to be prepared" })).toBeInTheDocument();
    expect(screen.queryByText(/by hand|manual/i)).not.toBeInTheDocument();
  });
});
