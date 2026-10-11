import StaticPage from "../components/shop/StaticPage";

// The refund copy has no {company} placeholder (it points to the Contact page
// instead), so no args are needed.
export default function RefundPage() {
  return (
    <StaticPage
      prefix="refund"
      blocks={5}
      // Block 1 (when a refund applies) stays a tip, block 2 (when it doesn't)
      // stays a warning — same Callout wrappers as the timeline layout.
      steps={[
        { id: "web.refund_h1", block: 1, callout: "tip" },
        { id: "web.refund_h2", block: 2, callout: "warning" },
        { id: "web.refund_h3", block: 3 },
        { id: "web.refund_h4", block: 4 },
        { id: "web.refund_h5", block: 5 },
      ]}
    />
  );
}
