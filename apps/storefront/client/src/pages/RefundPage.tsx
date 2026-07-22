import { CircleCheck, CircleX, ShieldQuestionMark, Ticket, Wallet } from "lucide-react";
import StaticPage from "../components/shop/StaticPage";

export default function RefundPage() {
  return (
    <StaticPage
      prefix="refund"
      blocks={5}
      steps={[
        { icon: CircleCheck, callout: "tip" },
        { icon: CircleX, callout: "warning" },
        { icon: Ticket },
        { icon: Wallet },
        { icon: ShieldQuestionMark },
      ]}
    />
  );
}
