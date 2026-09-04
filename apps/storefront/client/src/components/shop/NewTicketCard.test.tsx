import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewTicketCard, { type NewTicketCardProps, type NewTicketFormValue } from "./NewTicketCard";
import { t } from "../../lib/i18n";

const emptyValue: NewTicketFormValue = {
  subject: "",
  category: "",
  productId: "",
  orderCode: "",
  description: "",
  files: [],
};

function makeProps(over: Partial<NewTicketCardProps> = {}): NewTicketCardProps {
  return {
    value: emptyValue,
    onChange: vi.fn(),
    products: [
      { id: 1, name: "Alight Motion" },
      { id: 2, name: "Canva Pro" },
    ],
    orders: [
      { code: "ORD-1001", items: "Alight Motion 1 year" },
      { code: "ORD-1002", items: "Canva Pro 1 month" },
    ],
    errors: {},
    onSubmit: vi.fn(),
    isSubmitting: false,
    uploadProgress: 0,
    ...over,
  };
}

const validValue: NewTicketFormValue = {
  subject: "Cannot log in",
  category: "ACCOUNT",
  productId: "1",
  orderCode: "",
  description: "It fails every single time I try.",
  files: [],
};

describe("NewTicketCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the header, subtitle and every field label", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByText(t("web.support_create_title"))).toBeInTheDocument();
    expect(screen.getByText(t("web.support_create_subtitle"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.support_field_subject"), { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.support_field_category"), { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.support_field_product"), { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.support_field_order"), { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.support_field_description"), { exact: false })).toBeInTheDocument();
  });

  it("lists the mapped category option labels", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByRole("option", { name: t("web.support_field_category_placeholder") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: t("web.support_category_order") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: t("web.support_category_game_topup") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: t("web.support_category_other") })).toBeInTheDocument();
  });

  it("renders product options from the products prop", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByRole("option", { name: "Alight Motion" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Canva Pro" })).toBeInTheDocument();
  });

  it("offers the 'not about a specific order' default plus one option per order", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByRole("option", { name: t("web.ticket_order_picker_none") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "#ORD-1001 — Alight Motion 1 year" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "#ORD-1002 — Canva Pro 1 month" })).toBeInTheDocument();
  });

  it("puts Category and Product in a side-by-side grid from the sm breakpoint", () => {
    const { container } = render(<NewTicketCard {...makeProps()} />);
    const grid = container.querySelector(".sm\\:grid-cols-2");
    expect(grid).not.toBeNull();
    expect(grid!.querySelectorAll("select")).toHaveLength(2);
  });

  it("shows the safety notice text and the Send ticket button", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByText(t("web.support_safety_title"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(t("web.support_send_ticket"), "i") })).toBeInTheDocument();
  });

  it("updates the subject counter and calls onChange while typing in Subject", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<NewTicketCard {...makeProps({ onChange })} />);
    expect(screen.getByText("0/100")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(t("web.support_field_subject"), { exact: false }), "H");
    expect(onChange).toHaveBeenCalledWith({ subject: "H" });
    rerender(<NewTicketCard {...makeProps({ onChange, value: { ...emptyValue, subject: "Hello" } })} />);
    expect(screen.getByText("5/100")).toBeInTheDocument();
  });

  it("updates the description counter (x/1000)", () => {
    render(<NewTicketCard {...makeProps({ value: { ...emptyValue, description: "abcd" } })} />);
    expect(screen.getByText("4/1000")).toBeInTheDocument();
  });

  it("blocks submit and shows the subject error when Subject is empty", async () => {
    const onSubmit = vi.fn();
    render(<NewTicketCard {...makeProps({ onSubmit })} />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(t("web.support_send_ticket"), "i") }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toContain(t("web.support_err_subject"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit once every required field is valid", async () => {
    const onSubmit = vi.fn();
    render(<NewTicketCard {...makeProps({ onSubmit, value: validValue })} />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(t("web.support_send_ticket"), "i") }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("disables the button and shows the sending state while submitting", () => {
    render(<NewTicketCard {...makeProps({ isSubmitting: true })} />);
    const btn = screen.getByRole("button", { name: new RegExp(t("web.support_sending"), "i") });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("renders a server error from the errors prop under the matching field", () => {
    render(<NewTicketCard {...makeProps({ errors: { category: "Category no longer available" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Category no longer available");
  });

  it("renders the EvidenceUploader trigger from Task 15", () => {
    render(<NewTicketCard {...makeProps()} />);
    expect(screen.getByRole("button", { name: /attach files/i })).toBeInTheDocument();
  });

  it("shows the upload progress bar only while submitting with staged files", () => {
    const withFile: NewTicketFormValue = {
      ...emptyValue,
      files: [new File(["x"], "a.png", { type: "image/png" })],
    };
    const { rerender } = render(<NewTicketCard {...makeProps({ value: withFile })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<NewTicketCard {...makeProps({ value: withFile, isSubmitting: true, uploadProgress: 40 })} />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});
