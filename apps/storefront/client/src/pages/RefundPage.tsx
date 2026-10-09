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
      steps={[{ callout: "tip" }, { callout: "warning" }, {}, {}, {}]}
    />
  );
}
