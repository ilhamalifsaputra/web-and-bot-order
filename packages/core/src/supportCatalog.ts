/** One issue taxonomy for all support channels. Labels are locale keys. */
export const SUPPORT_CATEGORIES = [
  { key: "ORDER", issues: ["not_received", "pending", "unusable", "incorrect", "game_not_received", "cancel_refund", "other"], order: true },
  { key: "PAYMENT", issues: ["unconfirmed", "failed", "incorrect_amount", "wallet_pending", "balance_incorrect", "refund", "other"], order: true },
  { key: "ACCOUNT", issues: ["login", "telegram_login", "linking", "profile", "security", "other"], order: false },
  { key: "OTHER", issues: ["product_question", "website", "telegram", "transaction", "bug", "suggestion", "other"], order: false },
] as const;

export function supportIssue(category: string, issue: string) {
  const group = SUPPORT_CATEGORIES.find((c) => c.key === category);
  return group && (group.issues as readonly string[]).includes(issue)
    ? { category: group.key, issue, labelKey: `helpdesk.issue.${category.toLowerCase()}_${issue}`, order: group.order }
    : null;
}

export const SUPPORT_MAX_FILES = 3;
export const SUPPORT_MAX_TEXT = 2000;
export const SUPPORT_MIN_DESCRIPTION = 10;
