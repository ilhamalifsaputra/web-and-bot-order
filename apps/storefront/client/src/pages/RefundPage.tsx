import StaticPage from "../components/shop/StaticPage";

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
