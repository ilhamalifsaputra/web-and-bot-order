import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Save,
  SquarePen,
  KeyRound,
  Settings as SettingsIcon,
  Bot,
  Mail,
  CreditCard,
  SlidersHorizontal,
  ArrowLeftRight,
  Copy,
  Check,
  TriangleAlert,
  RefreshCw,
  Download,
  Upload,
  DatabaseBackup,
  MoreVertical,
  Users,
  Gamepad2,
  UserSearch,
  Globe,
  Store,
} from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { SaveConfirmDialog } from "../components/shared/SaveConfirmDialog";
import { SettingsSearch, highlightMatch, matchesQuery } from "@/components/shared/SettingsSearch";
import { SettingsNav, type SettingsNavLink } from "@/components/shared/SettingsNav";
import { SettingsHealthCard, type HealthSection } from "@/components/shared/SettingsHealthCard";
import { SettingsSaveStatus } from "@/components/shared/SettingsSaveStatus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiPost, apiGet } from "../api/client";
import { useSettings, type SettingsField, type PayMethodState } from "@/hooks/useSettings";
import { describeError } from "@/lib/errorMessages";
import { HEALTH_DOT } from "@/lib/healthDot";
import { UrgencyDot } from "@/components/shared/UrgencyDot";
import type { HealthEntry } from "@/api/types";

// Field groupings — must match the server-side EDITABLE keys exactly.
const BRANDING_KEYS = new Set([
  "shop_name",
  "shop_tagline",
  "welcome",
  "banner_image",
  "support_contact",
  "support_whatsapp",
]);

const TELEGRAM_KEYS = new Set([
  "bot_token",
  "bot_username",
  "notif_bot_token",
  "public_channel_id",
]);

const JOIN_GATE_KEYS = new Set([
  "join_gate_channel_id",
  "join_gate_group_id",
]);

// The rate itself, plus every lever that decides whether a fetched rate is
// trusted and how long a saved one stays usable. The M13 sanity-band keys and
// the quote TTL used to fall through to "Other Settings", which put the three
// figures that can silently switch the whole USDT rail off somewhere nobody
// looking at the rate would find them.
const FX_KEYS = new Set([
  "usd_idr_rate",
  "usd_idr_rate_auto",
  "usd_idr_rate_rounding",
  "usdt_spread_bps",
  "usdt_rounding_ceil_since",
  "fx_rate_min",
  "fx_rate_max",
  "fx_rate_max_delta_pct",
  "fx_quote_ttl_minutes",
  "fx_rate_max_age_hours",
]);

const SMTP_KEYS = new Set([
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_from",
  "smtp_secure",
  // Owner-notification keys — not SMTP transport settings themselves, but
  // rendered in the same "Email (SMTP)" Card (below the SMTP fields) since
  // mail configuration belongs in one place. This Set's name stays SMTP_KEYS
  // to avoid a churny rename; membership, not naming, is what matters here.
  "owner_email",
  "owner_email_enabled",
  "owner_email_on_paid_order",
  "owner_email_on_manual_queue",
  "owner_email_on_new_ticket",
  "owner_email_on_ticket_reply",
  "owner_email_on_wallet_topup",
]);

// Per-method credential field groupings. The _enabled field for each method
// is intentionally excluded here — it's surfaced as a toggle in the card header
// via payMethodState/togglePayment instead. Still included in PAY_CRED_KEYS
// so it doesn't fall through to "Other Settings".
const PAY_CRED_GROUPS = [
  {
    methodKey: "tokopay",
    label: "TokoPay",
    fieldKeys: ["tokopay_merchant_id", "tokopay_secret", "tokopay_min_amount"],
  },
  {
    methodKey: "paydisini",
    label: "PayDisini",
    fieldKeys: [
      "paydisini_userkey",
      "paydisini_apikey",
      "paydisini_default_channel",
      "paydisini_min_amount",
    ],
  },
  {
    methodKey: "nowpayments",
    label: "NOWPayments",
    fieldKeys: [
      "nowpayments_api_key",
      "nowpayments_ipn_secret",
      "nowpayments_pay_currency",
      "nowpayments_min_amount",
    ],
  },
  {
    methodKey: "bybit",
    label: "Bybit",
    fieldKeys: ["bybit_uid", "bybit_api_key", "bybit_api_secret", "bybit_min_amount"],
  },
  {
    methodKey: "bybit_bsc",
    label: "Bybit BSC",
    fieldKeys: [
      "bybit_bsc_deposit_address",
      "bybit_bsc_min_amount",
      "bscscan_api_key",
      "bybit_bsc_required_confirmations",
    ],
  },
  {
    methodKey: "binance_internal",
    label: "Binance Internal Transfer",
    fieldKeys: [
      "binance_receive_uid",
      "binance_api_key",
      "binance_api_secret",
      "binance_internal_min_amount",
    ],
  },
] as const;

const PAY_CRED_KEYS = new Set([
  "tokopay_merchant_id", "tokopay_secret", "tokopay_enabled", "tokopay_min_amount",
  "paydisini_userkey", "paydisini_apikey", "paydisini_enabled", "paydisini_default_channel", "paydisini_min_amount",
  "nowpayments_api_key", "nowpayments_ipn_secret", "nowpayments_enabled", "nowpayments_pay_currency", "nowpayments_min_amount",
  "bybit_uid", "bybit_api_key", "bybit_api_secret", "bybit_enabled", "bybit_min_amount",
  "bybit_bsc_deposit_address", "bybit_bsc_enabled", "bybit_bsc_min_amount", "bscscan_api_key", "bybit_bsc_required_confirmations",
  "binance_receive_uid", "binance_api_key", "binance_api_secret", "binance_internal_enabled", "binance_internal_min_amount",
]);

// Digiflazz supplier credentials + markup rule — not a checkout payment
// method (customers never select it), so it gets its own Card rather than
// PAY_CRED_GROUPS/GatewayCard's enable-switch-tied-to-payment-selection shape.
const DIGIFLAZZ_KEYS = new Set([
  "digiflazz_username",
  "digiflazz_api_key",
  "digiflazz_enabled",
  "digiflazz_markup_type",
  "digiflazz_markup_value",
]);

// KokinPay: the live nickname-check lookup (Task 7) — a separate paid
// service from Digiflazz, so its own Card rather than folding it into
// DIGIFLAZZ_KEYS. Same "not a checkout payment method" reasoning as
// Digiflazz above: it gets its own Card, not PAY_CRED_GROUPS/GatewayCard.
const KOKINPAY_KEYS = new Set(["kokinpay_api_key"]);

// VIP-Reseller: a second, independent region-check lookup (Region-check Task
// A) — used only to detect a buyer's account region on Mobile Legends
// lookups, catching a buyer who picked the wrong region variant of a game.
// Same "not a checkout payment method" reasoning as KokinPay above: its own
// Card, not PAY_CRED_GROUPS/GatewayCard. Two required fields (unlike
// KokinPay's one), so the Card's Test Connection button gates on both.
const VIPRESELLER_KEYS = new Set(["vipreseller_api_id", "vipreseller_api_key"]);

// MeloStore: a third, independent nickname-check provider (multi-provider
// nickname check plan) — same "not a checkout payment method" reasoning as
// KokinPay/VIP-Reseller above: its own Card, not PAY_CRED_GROUPS/GatewayCard.
// Two required fields (API key + secret key), like VIP-Reseller.
const MELOSTORE_KEYS = new Set(["melostore_api_key", "melostore_secret_key"]);

const ALL_GROUPED_KEYS = new Set([
  ...BRANDING_KEYS,
  ...TELEGRAM_KEYS,
  ...JOIN_GATE_KEYS,
  ...SMTP_KEYS,
  ...FX_KEYS,
  ...PAY_CRED_KEYS,
  ...DIGIFLAZZ_KEYS,
  ...KOKINPAY_KEYS,
  ...VIPRESELLER_KEYS,
  ...MELOSTORE_KEYS,
]);

// Short, muted helper description per field (Settings refinement §6) — every
// EDITABLE key from apps/web-admin/src/routes/api/settings.ts should have an
// entry; a key with none simply renders no description line.
const FIELD_DESCRIPTIONS: Record<string, string> = {
  shop_name: "Displayed on the website header, checkout page and invoices.",
  shop_tagline: "A short line shown under the shop name on the storefront.",
  welcome: "Shown when a customer starts the Telegram bot.",
  banner_image: "Displayed on the storefront homepage banner.",
  support_contact: "Displayed on customer support buttons.",
  support_whatsapp: "WhatsApp number shown as a support option on the website.",
  web_analytics_id: "Google Analytics measurement ID, used to track storefront visits.",
  usd_idr_rate: "Rupiah per 1 USDT, used to price USDT gateways in IDR.",
  usd_idr_rate_auto: "Automatically refresh the rate from the market instead of setting it by hand.",
  usd_idr_rate_rounding: "Rounds the auto-fetched rate to the nearest step (e.g. 100).",
  usdt_spread_bps:
    "Shaves the auto-fetched rate down so buyers send slightly more USDT — 100 = 1%. It is applied only to the automatic refresh; a rate you type in by hand is saved exactly as typed. It does not count towards the maximum move below, so any size is safe there, but the floor and ceiling above still judge the rate after it is applied.",
  usdt_rounding_ceil_since:
    "When this shop started rounding USDT amounts up to the cent instead of to the nearest 0.1. It does not affect prices at all — the six-hourly finance check uses it to tell an older order priced the old way apart from one that is genuinely wrong. It is filled in for you at upgrade time; only change it if that date is wrong. Empty means the check assumes every order was priced the current way.",
  fx_rate_min: "Refuses an auto-fetched rate below this — catches a rate source that starts answering in the wrong unit. Blank turns the check off.",
  fx_rate_max: "Refuses an auto-fetched rate above this — catches a rate source returning a placeholder. Blank turns the check off.",
  fx_rate_max_delta_pct:
    "How far the market rate may move between two accepted refreshes. It is measured market-to-market, so the spread above never counts as part of the move — a refresh is only refused when the market itself jumped this far, which usually means the rate source is misbehaving.",
  fx_quote_ttl_minutes:
    "Stops offering USDT payment methods once the saved rate has gone this long without being refreshed or re-typed, and refuses any USDT order submitted anyway. USDT prices are still shown. Every admin is DMed when it trips. Keep it at a few times the hourly update interval so one missed update does not switch USDT off; blank or 0 turns the check off.",
  fx_rate_max_age_hours:
    "Hides USDT payments shop-wide once the saved rate has gone this long without being refreshed or re-typed — the outer limit, measured in hours. Blank or 0 turns the check off.",
  min_order_amount_idr:
    "Smallest amount customers can pay — an order total or a wallet top-up — on any payment method that has no minimum of its own. Blank turns it off and leaves only the per-method minimums.",
  tokopay_merchant_id: "Your TokoPay merchant account identifier.",
  tokopay_secret: "Signs requests to TokoPay — never shown once saved.",
  tokopay_min_amount:
    "Minimum amount customers can pay via TokoPay — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  paydisini_userkey: "Your PayDisini account's user key.",
  paydisini_apikey: "Authenticates requests to PayDisini — never shown once saved.",
  paydisini_default_channel: "Default PayDisini payment channel offered at checkout.",
  paydisini_min_amount:
    "Minimum amount customers can pay via PayDisini — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  nowpayments_api_key: "Authenticates requests to NOWPayments — never shown once saved.",
  nowpayments_ipn_secret: "Verifies that payment webhooks really came from NOWPayments.",
  nowpayments_pay_currency: "Cryptocurrency customers pay with via NOWPayments.",
  nowpayments_min_amount:
    "Minimum amount customers can pay via NOWPayments — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  bybit_uid: "Your Bybit account's UID — where internal transfers are received.",
  bybit_api_key: "Read-only Bybit API key used to detect incoming transfers.",
  bybit_api_secret: "Signs Bybit API requests — never shown once saved.",
  bybit_min_amount:
    "Minimum amount customers can pay via Bybit Internal Transfer — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  bybit_bsc_deposit_address: "BEP20 wallet address customers send USDT to on-chain.",
  bybit_bsc_min_amount:
    "Minimum amount customers can pay via Bybit BSC — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  bscscan_api_key: "Optional — raises the BscScan lookup rate limit for confirmation tracking.",
  bybit_bsc_required_confirmations: "On-chain confirmations required before a BSC deposit is trusted.",
  binance_receive_uid: "Your Binance account's UID — where internal transfers are received.",
  binance_api_key: "Read-only Binance API key used to detect incoming transfers.",
  binance_api_secret: "Signs Binance API requests — never shown once saved.",
  binance_internal_min_amount:
    "Minimum amount customers can pay via Binance Internal Transfer — an order total or a wallet top-up. Raising it also raises the minimum the top-up forms advertise.",
  bot_token: "The Telegram bot customers order through. Changing this needs a restart.",
  notif_bot_token: "A second bot used only for admin/channel notifications. Changing this needs a restart.",
  public_channel_id: "Public Telegram channel order/stock updates are posted to. Changing this needs a restart.",
  join_gate_channel_id: "Customers must join this channel before they can use the bot. Paste a @username, t.me link, or numeric id — the bot must already be an admin of the chat. Leave blank to not require a channel.",
  join_gate_group_id: "Customers must join this group before they can use the bot. Paste a @username, t.me link, or numeric id — the bot must already be an admin of the chat. Leave blank (and the channel above) to turn the join requirement off entirely.",
  smtp_host: "Your email provider's SMTP server, e.g. smtp.hostinger.com.",
  smtp_port: "SMTP port — commonly 465 (SSL/TLS) or 587 (STARTTLS).",
  smtp_user: "SMTP login username, usually the sending email address.",
  smtp_pass: "Signs in to the SMTP server — never shown once saved.",
  smtp_from: 'Sender shown on password-reset emails, e.g. "Shop Name <no-reply@example.com>".',
  smtp_secure: 'Type "true" for port 465 (SSL/TLS), or "false" for port 587 (STARTTLS).',
  owner_email: "Where owner notification emails are sent.",
  owner_email_enabled: 'Master switch — type "true" or "false". All owner emails are off unless this is true.',
  owner_email_on_paid_order: 'Type "true" or "false" — email the owner when an auto-delivered order is paid.',
  owner_email_on_manual_queue: 'Type "true" or "false" — email the owner when a paid order needs hand fulfilment.',
  owner_email_on_new_ticket: 'Type "true" or "false" — email the owner when a customer opens a support ticket.',
  owner_email_on_ticket_reply: 'Type "true" or "false" — email the owner when a customer replies to a support ticket.',
  owner_email_on_wallet_topup: 'Type "true" or "false" — email the owner when a buyer tops up their wallet balance.',
  custom_emoji_map: "Maps emoji in bot messages to Telegram Premium custom emoji ids.",
  bulk_purchase_broadcast_enabled: "Post a message to the public channel when a large purchase happens.",
  bulk_purchase_broadcast_threshold: "Minimum quantity in one order that triggers the broadcast.",
  bulk_purchase_broadcast_template: "Message template — supports {qty}, {product}, {denomination}.",
  digiflazz_username: "Your Digiflazz account username.",
  digiflazz_api_key: "Authenticates requests to Digiflazz — never shown once saved.",
  digiflazz_enabled: 'Type "true" or "false" — turns Digiflazz auto-fulfilment off without clearing the saved credentials.',
  digiflazz_markup_type: "How the markup below is applied when pricing Digiflazz SKUs.",
  digiflazz_markup_value: "Percent (e.g. 8 for 8%) or a flat IDR amount, depending on the type above.",
  kokinpay_api_key: "Authenticates requests to KokinPay's nickname-check lookup — never shown once saved.",
  vipreseller_api_id: "Your VIP-Reseller account's API ID.",
  vipreseller_api_key: "Authenticates requests to VIP-Reseller's region-check lookup — never shown once saved.",
  melostore_api_key: "Authenticates requests to MeloStore's nickname-check lookup — never shown once saved.",
  melostore_secret_key: "Signs requests to MeloStore's nickname-check lookup — never shown once saved.",
};

/** Instant client-side echo of the server's own field-specific validation
 * (Settings refinement §11) — the server remains the real guard; this is
 * purely for immediate feedback while typing. Returns null when `value`
 * passes (or is empty — emptiness is handled separately by the required/
 * optional status badge, not this function). */
function validateField(key: string, value: string): string | null {
  if (value === "") return null;
  if (key === "support_whatsapp" && !/^\+?[0-9()\-\s]{6,20}$/.test(value)) {
    return "That doesn't look like a valid phone number.";
  }
  if (key === "web_analytics_id" && !/^G-[A-Z0-9]{4,20}$/i.test(value)) {
    return "Expected a Google Analytics measurement ID like G-ABC1234XYZ.";
  }
  if (key.endsWith("_min_amount")) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "Must be a positive number.";
  }
  if (key === "bybit_bsc_required_confirmations") {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return "Must be a positive whole number.";
  }
  if (key === "bulk_purchase_broadcast_threshold") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 2) return "Must be a whole number of 2 or more.";
  }
  if (key === "bulk_purchase_broadcast_template" && value.length > 500) {
    return "Keep it under 500 characters.";
  }
  if (key === "digiflazz_enabled" && !["true", "false"].includes(value.toLowerCase())) {
    return 'Must be "true" or "false".';
  }
  if (key === "digiflazz_markup_type" && !["percent", "flat"].includes(value)) {
    return 'Must be "percent" or "flat".';
  }
  if (key === "digiflazz_markup_value") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "Must be zero or a positive number.";
  }
  if (key === "smtp_port") {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return "Must be a positive whole number.";
  }
  if (key === "smtp_from" && !/^([^\s@]+@[^\s@]+\.[^\s@]+|.+<[^\s@]+@[^\s@]+\.[^\s@]+>)$/.test(value)) {
    return 'Expected an email, or "Name <email>".';
  }
  if (key === "smtp_secure" && !["true", "false"].includes(value.toLowerCase())) {
    return 'Must be "true" or "false".';
  }
  if (key === "owner_email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Expected a plain email address, e.g. owner@example.com.";
  }
  if (
    [
      "owner_email_enabled",
      "owner_email_on_paid_order",
      "owner_email_on_manual_queue",
      "owner_email_on_new_ticket",
      "owner_email_on_ticket_reply",
      "owner_email_on_wallet_topup",
    ].includes(key) &&
    !["true", "false"].includes(value.toLowerCase())
  ) {
    return 'Must be "true" or "false".';
  }
  return null;
}

/**
 * Configured/Not Configured/Error tone for a payment gateway card — separate
 * from the raw `enabled` toggle (F-013: "not configured" must never be
 * papered over by the toggle's own state; the two are now two distinct
 * widgets — this badge, and the Switch — rather than one combined text
 * label, so neither can misrepresent the other).
 */
function gatewayBadgeStatus(methodState: PayMethodState, testFailed: boolean): "CONFIGURED" | "NOT_CONFIGURED" | "ERROR" {
  if (!methodState.configured) return "NOT_CONFIGURED";
  if (testFailed) return "ERROR";
  return "CONFIGURED";
}

function fieldGroup(fields: SettingsField[], keys: Set<string>): SettingsField[] {
  return fields.filter((f) => keys.has(f.key));
}

function fieldsOther(fields: SettingsField[]): SettingsField[] {
  return fields.filter((f) => !ALL_GROUPED_KEYS.has(f.key));
}

interface TestResult {
  ok: boolean;
  detail: string;
}

const DIGIFLAZZ_MARKUP_TYPE_OPTIONS = [
  { value: "percent", label: "Percent" },
  { value: "flat", label: "Flat (IDR)" },
];

interface FieldRowProps {
  field: SettingsField;
  query: string;
  onSaved: () => void;
  onStatusChange: (key: string, status: "editing" | "saving" | null) => void;
  onNeedsRestart?: () => void;
  /** When set, the edit control is a `Select` with these options instead of
   * a free-text `Input` — matches the "Answer Type" idiom in
   * AdditionalFieldsEditor.tsx, for fields whose value is a fixed enum
   * (e.g. digiflazz_markup_type) rather than free text. */
  selectOptions?: { value: string; label: string }[];
}

function FieldRow({ field, query, onSaved, onStatusChange, onNeedsRestart, selectOptions }: FieldRowProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.value);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  if (query && !matchesQuery(field.label, query)) return null;

  const validationError = editing ? validateField(field.key, value) : null;

  function startEditing() {
    setEditing(true);
    setValue(field.value);
    onStatusChange(field.key, "editing");
  }

  function cancelEditing() {
    setEditing(false);
    setValue(field.value);
    onStatusChange(field.key, null);
  }

  async function save() {
    onStatusChange(field.key, "saving");
    try {
      await apiPost("/api/settings/edit", { key: field.key, value });
      setEditing(false);
      onStatusChange(field.key, null);
      if (field.needsRestart) onNeedsRestart?.();
      onSaved();
    } catch (err) {
      onStatusChange(field.key, "editing");
      throw err;
    }
  }

  async function copyValue() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1000);
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-md py-3 px-2 -mx-2 hover:bg-muted/50">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm font-medium text-ink">
          {field.secret && (
            <KeyRound
              className="mr-1 inline h-3.5 w-3.5 text-ink-faint"
              aria-label="Sensitive field"
            />
          )}
          {highlightMatch(field.label, query)}
          {field.needsRestart && <RestartRequiredBadge className="ml-2" />}
        </div>
        {FIELD_DESCRIPTIONS[field.key] && (
          <div className="mt-0.5 text-xs text-ink-soft">{FIELD_DESCRIPTIONS[field.key]}</div>
        )}
        {/* break-all: setting values are webhook/base URLs, bank account
            numbers and merchant ids — long unbroken tokens that used to run
            into the Edit/Copy buttons. Matches the TOTP secret below. */}
        {!editing && (
          <div className="mt-1 text-xs break-all text-ink-soft">
            {field.secret ? (
              field.hasValue ? "••••••••" : <StatusBadge status="NOT_CONFIGURED" />
            ) : (
              field.value || <StatusBadge status="OPTIONAL" />
            )}
          </div>
        )}
        {editing && (
          <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-2 items-center">
              {selectOptions ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger className="w-full max-w-sm" aria-label={field.label}>
                    <SelectValue placeholder="Select a type" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={field.secret ? "password" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validationError) setConfirmOpen(true);
                    if (e.key === "Escape") cancelEditing();
                  }}
                  aria-label={field.label}
                  aria-invalid={validationError ? true : undefined}
                  autoFocus
                  className="w-full max-w-sm"
                  // Reported bug: filling in a secret field (e.g. Digiflazz
                  // API key) here was landing in the page's own "Search
                  // settings…" box instead. Root cause: this is a generic
                  // setting value, not a real account credential, but
                  // rendering it as `type="password"` with no autoComplete
                  // hint and no <form> boundary makes Chrome's native
                  // password manager treat it as a login field — it pairs
                  // the field with the NEAREST PRECEDING text input on the
                  // page as a guessed "username" (here, SettingsSearch's own
                  // search box) and offers to autofill this admin's saved
                  // /login credentials into both. "new-password" is the
                  // standard signal that stops Chrome from treating a
                  // password-shaped input as a saved-login target; plain
                  // "off" for the non-secret case is just hygiene (a
                  // markup-type/value field has no business being
                  // autofilled either).
                  autoComplete={field.secret ? "new-password" : "off"}
                />
              )}
              {field.secret && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Copy ${field.label}`}
                  onClick={() => void copyValue()}
                  disabled={!value}
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-grass" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!!validationError}>
                <Save className="h-4 w-4" />
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelEditing}>
                Cancel
              </Button>
            </div>
            {validationError && <p className="text-sm text-rust">{validationError}</p>}
          </div>
        )}
      </div>
      {/* Rendered unconditionally (not inside `editing && …`) — save()
          flips `editing` false as soon as the request resolves, which would
          otherwise unmount this mid-animation and cut off the checkmark. */}
      <SaveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Save "${field.label}"?`}
        description="This updates the live setting immediately."
        onConfirm={save}
      />
      {!editing && (
        <Button size="sm" variant="ghost" onClick={startEditing} className="min-h-[44px] sm:min-h-0">
          <SquarePen className="h-4 w-4" />
          Edit
        </Button>
      )}
    </div>
  );
}

function RestartRequiredBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-4xl bg-amberx-tint px-2 py-0.5 text-xs font-semibold text-amberx ${className ?? ""}`}
    >
      <TriangleAlert className="size-3" aria-hidden="true" />
      Restart required
    </span>
  );
}

interface GatewayCardProps {
  methodKey: string;
  label: string;
  credFields: SettingsField[];
  methodState: PayMethodState;
  sectionId: string;
  query: string;
  onSaved: () => void;
  onStatusChange: (key: string, status: "editing" | "saving" | null) => void;
  onToggle: (methodKey: string, label: string, nextEnabled: boolean) => void;
  testResult: TestResult | undefined;
  onTest: (methodKey: string, label: string) => void;
  /** Poller health verdict (packages/core/src/payments/pollHealth.ts, mapped
   * server-side) — only set for the two Bybit rails, which have a heartbeat
   * poller behind them; every other gateway is request/response and has no
   * poller to report on, so this stays undefined for them and no row shows. */
  health?: HealthEntry;
}

function GatewayCard({
  methodKey,
  label,
  credFields,
  methodState,
  sectionId,
  query,
  onSaved,
  onStatusChange,
  onToggle,
  testResult,
  onTest,
  health,
}: GatewayCardProps) {
  return (
    <Card id={sectionId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle>{highlightMatch(label, query)}</CardTitle>
            <StatusBadge status={gatewayBadgeStatus(methodState, testResult?.ok === false)} />
          </div>
          {testResult && (
            <p className={`text-xs ${testResult.ok ? "text-grass-dark" : "text-rust"}`}>{testResult.detail}</p>
          )}
          {health && (
            <div className="flex items-center gap-1.5 text-xs text-ink-soft" title={health.detail}>
              <UrgencyDot level={HEALTH_DOT[health.status]} />
              {health.detail}
            </div>
          )}
        </div>
        <label
          className="flex min-h-[44px] items-center gap-2 cursor-pointer"
          title={
            methodState.configured
              ? undefined
              : "Add the credentials below to actually activate this gateway."
          }
        >
          <Switch
            checked={methodState.enabled}
            onCheckedChange={(checked) => onToggle(methodKey, label, checked)}
            aria-label={`${methodState.enabled ? "Disable" : "Enable"} ${label}`}
          />
        </label>
      </CardHeader>
      {credFields.length > 0 && (
        <CardContent className="divide-y divide-line pt-0">
          {credFields.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              query={query}
              onSaved={onSaved}
              onStatusChange={onStatusChange}
            />
          ))}
        </CardContent>
      )}
      <CardContent className="pt-0">
        <Button
          size="sm"
          variant="outline"
          disabled={!methodState.configured}
          title={methodState.configured ? undefined : "Add credentials above to test this gateway."}
          onClick={() => onTest(methodKey, label)}
        >
          Test Connection
        </Button>
      </CardContent>
    </Card>
  );
}

interface ImportPreview {
  fields: Record<string, string>;
  count: number;
}

function QuickActionsMenu({
  onExport,
  onImportFile,
  onRefreshConnections,
  refreshing,
}: {
  onExport: () => void;
  onImportFile: (preview: ImportPreview) => void;
  onRefreshConnections: () => void;
  refreshing: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { fields?: Record<string, string> };
      const fields = parsed.fields ?? {};
      onImportFile({ fields, count: Object.keys(fields).length });
    } catch {
      toast.error("That file doesn't look like a settings export — expected JSON with a \"fields\" object.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Settings quick actions">
          <MoreVertical className="h-4 w-4" />
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onExport}>
          <Download className="h-4 w-4" />
          Export Configuration
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExport}>
          <DatabaseBackup className="h-4 w-4" />
          Backup Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
          <Upload className="h-4 w-4" />
          Import Configuration
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
          <Upload className="h-4 w-4" />
          Restore Backup
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRefreshConnections} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh Connections
        </DropdownMenuItem>
      </DropdownMenuContent>
      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={(e) => void handleFile(e)} />
    </DropdownMenu>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, invalidate, fieldStatuses, setFieldStatus, lastSavedAt, markSaved } = useSettings();

  const [query, setQuery] = useState("");

  // Password change
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirmOpen, setPwConfirmOpen] = useState(false);

  // 2FA
  const [totpCode, setTotpCode] = useState("");
  const [tfaError, setTfaError] = useState<string | null>(null);
  const [tfaSaving, setTfaSaving] = useState(false);
  const [disablePw, setDisablePw] = useState("");
  const [disableTotp, setDisableTotp] = useState("");
  const [tfaEnableConfirmOpen, setTfaEnableConfirmOpen] = useState(false);
  const [tfaDisableConfirmOpen, setTfaDisableConfirmOpen] = useState(false);

  // FX refresh
  const [fxConfirmOpen, setFxConfirmOpen] = useState(false);
  const [fxLastRefreshedAt, setFxLastRefreshedAt] = useState<number | null>(null);

  // Payment gateway toggle
  const [pendingToggle, setPendingToggle] = useState<
    { methodKey: string; label: string; nextEnabled: boolean } | null
  >(null);

  // Connection tests
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [pendingTest, setPendingTest] = useState<{ methodKey: string; label: string } | null>(null);
  const [refreshingConnections, setRefreshingConnections] = useState(false);

  // Restart
  const [restartPending, setRestartPending] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);

  // Import
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);

  function onSaved() {
    invalidate();
    markSaved();
  }

  function onStatusChange(key: string, status: "editing" | "saving" | null) {
    setFieldStatus(key, status);
  }

  async function refreshFx() {
    const result = await apiPost<{ ok: boolean; status: string; rate: string }>(
      "/api/settings/fx/refresh",
      {},
    );
    setFxLastRefreshedAt(Date.now());
    onSaved();
    return `Rate updated to ${result.rate} (${result.status})`;
  }

  async function changePassword() {
    await apiPost("/api/settings/password", {
      current_password: pwCurrent,
      new_password: pwNew,
    });
    setPwCurrent("");
    setPwNew("");
    markSaved();
    return "Password changed successfully.";
  }

  async function tfaAction(path: string, body: Record<string, string>) {
    setTfaSaving(true);
    setTfaError(null);
    try {
      await apiPost(path, body);
      setTotpCode("");
      setDisablePw("");
      setDisableTotp("");
      invalidate();
    } catch (err) {
      setTfaError(err instanceof Error ? err.message : "Failed");
    } finally {
      setTfaSaving(false);
    }
  }

  async function enableTwoFa() {
    await apiPost("/api/settings/2fa/enable", { totp_code: totpCode });
    setTotpCode("");
    invalidate();
    markSaved();
    return "Two-factor authentication enabled.";
  }

  async function disableTwoFa() {
    await apiPost("/api/settings/2fa/disable", {
      current_password: disablePw,
      totp_code: disableTotp,
    });
    setDisablePw("");
    setDisableTotp("");
    invalidate();
    markSaved();
    return "Two-factor authentication disabled.";
  }

  const togglePayment = useMutation({
    mutationFn: ({ method, enabled }: { method: string; enabled: boolean }) =>
      apiPost("/api/settings/payments/toggle", { method, enabled: enabled ? "true" : "false" }),
    onSuccess: () => { invalidate(); markSaved(); },
  });

  async function runTest(methodKey: string) {
    const result = await apiPost<TestResult>(`/api/settings/payments/${methodKey}/test`, {});
    setTestResults((prev) => ({ ...prev, [methodKey]: result }));
    return result.detail;
  }

  async function runRestart() {
    await apiPost("/api/settings/restart", {});
    setRestartPending(false);
    markSaved();
    return "Restart triggered — the bot process will pick up the change shortly.";
  }

  async function handleExport() {
    try {
      const result = await apiGet<{ exportedAt: string; fields: Record<string, string> }>("/api/settings/export");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `settings-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${Object.keys(result.fields).length} settings.`);
    } catch (err) {
      toast.error(describeError(err, "Export failed"));
    }
  }

  function handleImportFile(preview: ImportPreview) {
    setImportPreview(preview);
    setImportConfirmOpen(true);
  }

  async function runImport() {
    if (!importPreview) return "Nothing to import.";
    const result = await apiPost<{ ok: boolean; applied: number; skipped: number }>("/api/settings/import", {
      fields: importPreview.fields,
    });
    invalidate();
    markSaved();
    return `Imported ${result.applied} setting${result.applied === 1 ? "" : "s"}; skipped ${result.skipped}.`;
  }

  async function handleRefreshConnections() {
    if (!data) return;
    setRefreshingConnections(true);
    try {
      const methods = Object.keys(data.payMethodState);
      const results = await Promise.allSettled(
        methods.map(async (methodKey) => {
          const result = await apiPost<TestResult>(`/api/settings/payments/${methodKey}/test`, {});
          return [methodKey, result] as const;
        }),
      );
      const next: Record<string, TestResult> = {};
      let okCount = 0;
      for (const r of results) {
        if (r.status === "fulfilled") {
          const [methodKey, result] = r.value;
          next[methodKey] = result;
          if (result.ok) okCount++;
        }
      }
      setTestResults((prev) => ({ ...prev, ...next }));
      toast.success(`${okCount} of ${methods.length} connections OK.`);
    } finally {
      setRefreshingConnections(false);
    }
  }

  if (!data) {
    return (
      <PageLayout title="Settings">
        <PageHeader title="Settings" />
        {isLoading && <p className="text-ink-soft">Loading settings…</p>}
        {isError && <p className="text-rust">Failed to load settings.</p>}
      </PageLayout>
    );
  }

  const showGeneral = fieldGroup(data.fields, BRANDING_KEYS).length > 0;
  const showTelegram = fieldGroup(data.fields, TELEGRAM_KEYS).length > 0;
  const showJoinGate = fieldGroup(data.fields, JOIN_GATE_KEYS).length > 0;
  const showSmtp = fieldGroup(data.fields, SMTP_KEYS).length > 0;
  const showOther = fieldsOther(data.fields).length > 0;
  const payGroups = PAY_CRED_GROUPS.map(({ methodKey, label, fieldKeys }) => {
    const credFields = data.fields.filter((f) => (fieldKeys as readonly string[]).includes(f.key));
    const methodState = data.payMethodState[methodKey];
    return { methodKey, label, credFields, methodState, sectionId: `settings-pay-${methodKey}` };
    // Every PAY_CRED_GROUPS entry has a matching PAYMENT_METHODS entry
    // server-side, so `methodState` is always present in practice — the
    // type predicate below just makes that explicit for TypeScript.
  }).filter((g): g is typeof g & { methodState: PayMethodState } => g.methodState !== undefined);

  // Search visibility — a section is visible if its own title matches, or any
  // field inside it does; a field row filters further inside FieldRow itself.
  function sectionVisible(label: string, fields: SettingsField[]): boolean {
    if (!query) return true;
    if (matchesQuery(label, query)) return true;
    return fields.some((f) => matchesQuery(f.label, query));
  }
  // When a section's own title matched, its individual FieldRows should all
  // stay visible (not re-filtered down to a label match) — FieldRow only
  // hides a row on an unmatched query, so pass "" to it in that case.
  function fieldQueryFor(label: string): string {
    return query && matchesQuery(label, query) ? "" : query;
  }

  const generalFields = fieldGroup(data.fields, BRANDING_KEYS);
  const telegramFields = fieldGroup(data.fields, TELEGRAM_KEYS);
  const joinGateFields = fieldGroup(data.fields, JOIN_GATE_KEYS);
  const smtpFields = fieldGroup(data.fields, SMTP_KEYS);
  const otherFields = fieldsOther(data.fields);
  const fxFields = fieldGroup(data.fields, FX_KEYS);
  const digiflazzFields = fieldGroup(data.fields, DIGIFLAZZ_KEYS);
  const kokinpayFields = fieldGroup(data.fields, KOKINPAY_KEYS);
  const vipresellerFields = fieldGroup(data.fields, VIPRESELLER_KEYS);
  const melostoreFields = fieldGroup(data.fields, MELOSTORE_KEYS);

  const generalVisible = showGeneral && sectionVisible("General", generalFields);
  const telegramVisible = showTelegram && sectionVisible("Telegram & Bot", telegramFields);
  const joinGateVisible = showJoinGate && sectionVisible("Join Gate", joinGateFields);
  const smtpVisible = showSmtp && sectionVisible("Email (SMTP)", smtpFields);
  const otherVisible = showOther && sectionVisible("Other Settings", otherFields);
  const fxVisible = sectionVisible("Exchange Rates", fxFields);
  const digiflazzVisible = sectionVisible("Digiflazz (Top Up Game)", digiflazzFields);
  const kokinpayVisible = sectionVisible("KokinPay (Nickname Check)", kokinpayFields);
  const vipresellerVisible = sectionVisible("VIP-Reseller (Region Check)", vipresellerFields);
  const melostoreVisible = sectionVisible("MeloStore (Nickname Check)", melostoreFields);
  const securityVisible = sectionVisible("Security", []);
  const payGroupsVisible = payGroups.map((g) => ({ ...g, visible: sectionVisible(g.label, g.credFields) }));

  const navIcon = (Icon: typeof SettingsIcon) => Icon;
  const topLinks: SettingsNavLink[] = [
    ...(showGeneral ? [{ id: "settings-general", label: "General", icon: navIcon(SettingsIcon), visible: generalVisible }] : []),
    ...(showTelegram ? [{ id: "settings-telegram", label: "Telegram & Bot", icon: navIcon(Bot), visible: telegramVisible }] : []),
    ...(showJoinGate ? [{ id: "settings-joingate", label: "Join Gate", icon: navIcon(Users), visible: joinGateVisible }] : []),
    ...(showSmtp ? [{ id: "settings-email", label: "Email (SMTP)", icon: navIcon(Mail), visible: smtpVisible }] : []),
  ];
  const bottomLinks: SettingsNavLink[] = [
    ...(showOther ? [{ id: "settings-other", label: "Other Settings", icon: navIcon(SlidersHorizontal), visible: otherVisible }] : []),
    { id: "settings-exchange-rates", label: "Exchange Rates", icon: navIcon(ArrowLeftRight), visible: fxVisible },
    { id: "settings-digiflazz", label: "Digiflazz (Top Up Game)", icon: navIcon(Gamepad2), visible: digiflazzVisible },
    { id: "settings-kokinpay", label: "KokinPay (Nickname Check)", icon: navIcon(UserSearch), visible: kokinpayVisible },
    { id: "settings-vipreseller", label: "VIP-Reseller (Region Check)", icon: navIcon(Globe), visible: vipresellerVisible },
    { id: "settings-melostore", label: "MeloStore (Nickname Check)", icon: navIcon(Store), visible: melostoreVisible },
    { id: "settings-security", label: "Security", icon: navIcon(KeyRound), visible: securityVisible },
  ];

  const healthSections: HealthSection[] = [
    { label: "Shop Information", status: (fieldGroup(data.fields, new Set(["shop_name"]))[0]?.hasValue ? "CONFIGURED" : "NOT_CONFIGURED") },
    { label: "Telegram Bot", status: telegramFields.find((f) => f.key === "bot_token")?.hasValue ? "CONFIGURED" : "NOT_CONFIGURED" },
    { label: "Payment Gateway", status: Object.values(data.payMethodState).some((m) => m.configured) ? "CONFIGURED" : "NOT_CONFIGURED" },
    { label: "Exchange Rates", status: fxFields.find((f) => f.key === "usd_idr_rate")?.hasValue ? "CONFIGURED" : "NOT_CONFIGURED" },
    { label: "Email (SMTP)", status: smtpFields.find((f) => f.key === "smtp_host")?.hasValue ? "CONFIGURED" : "OPTIONAL" },
    { label: "Security", status: data.twoFaEnabled ? "CONFIGURED" : "OPTIONAL" },
  ];

  return (
    <PageLayout title="Settings">
      <PageHeader
        title="Settings"
        actions={
          <>
            <SettingsSaveStatus fieldStatuses={fieldStatuses} lastSavedAt={lastSavedAt} />
            <QuickActionsMenu
              onExport={() => void handleExport()}
              onImportFile={handleImportFile}
              onRefreshConnections={() => void handleRefreshConnections()}
              refreshing={refreshingConnections}
            />
          </>
        }
      />

      <SettingsHealthCard sections={healthSections} />

      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8">
        <div className="lg:sticky lg:top-4">
          <SettingsSearch value={query} onChange={setQuery} />
          <SettingsNav
            topLinks={topLinks}
            group={
              payGroupsVisible.length > 0
                ? {
                    label: "Payment Gateways",
                    icon: CreditCard,
                    links: payGroupsVisible.map((g) => ({ id: g.sectionId, label: g.label, icon: CreditCard, visible: g.visible })),
                  }
                : null
            }
            bottomLinks={bottomLinks}
          />
        </div>

        <div className="flex flex-col gap-6 max-w-2xl [&>*]:scroll-mt-20">

          {/* General */}
          {generalVisible && (
            <Card id="settings-general">
              <CardHeader>
                <CardTitle as="h2">General</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {generalFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("General")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Telegram & Bot */}
          {telegramVisible && (
            <Card id="settings-telegram">
              <CardHeader>
                <CardTitle as="h2">Telegram &amp; Bot</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {telegramFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("Telegram & Bot")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                    onNeedsRestart={() => setRestartPending(true)}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!telegramFields.find((f) => f.key === "bot_token")?.hasValue}
                  onClick={() => setPendingTest({ methodKey: "__telegram_bot_token__", label: "Order Bot token" })}
                >
                  Test Connection
                </Button>
                {testResults.__telegram_bot_token__ && (
                  <p className={`text-xs ${testResults.__telegram_bot_token__.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.__telegram_bot_token__.detail}
                  </p>
                )}
                {restartPending && (
                  <div className="flex items-center gap-2">
                    <RestartRequiredBadge />
                    <Button size="sm" variant="outline" onClick={() => setRestartConfirmOpen(true)}>
                      Restart Bot
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Join Gate */}
          {joinGateVisible && (
            <Card id="settings-joingate">
              <CardHeader>
                <CardTitle as="h2">Join Gate</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {joinGateFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("Join Gate")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!joinGateFields.find((f) => f.key === "join_gate_channel_id")?.hasValue}
                  onClick={() => setPendingTest({ methodKey: "__telegram_join_channel__", label: "Join Gate channel" })}
                >
                  Test Connection (Channel)
                </Button>
                {testResults.__telegram_join_channel__ && (
                  <p className={`text-xs ${testResults.__telegram_join_channel__.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.__telegram_join_channel__.detail}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!joinGateFields.find((f) => f.key === "join_gate_group_id")?.hasValue}
                  onClick={() => setPendingTest({ methodKey: "__telegram_join_group__", label: "Join Gate group" })}
                >
                  Test Connection (Group)
                </Button>
                {testResults.__telegram_join_group__ && (
                  <p className={`text-xs ${testResults.__telegram_join_group__.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.__telegram_join_group__.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Email (SMTP) */}
          {smtpVisible && (
            <Card id="settings-email">
              <CardHeader>
                <CardTitle as="h2">Email (SMTP)</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {smtpFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("Email (SMTP)")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!smtpFields.find((f) => f.key === "smtp_host")?.hasValue}
                  onClick={() => setPendingTest({ methodKey: "__smtp__", label: "SMTP" })}
                >
                  Test Connection
                </Button>
                {testResults.__smtp__ && (
                  <p className={`text-xs ${testResults.__smtp__.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.__smtp__.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Payment Credentials — one card per method */}
          {payGroupsVisible.filter((g) => g.visible).map((g) => (
            <GatewayCard
              key={g.methodKey}
              methodKey={g.methodKey}
              label={g.label}
              credFields={g.credFields}
              methodState={g.methodState}
              sectionId={g.sectionId}
              query={fieldQueryFor(g.label)}
              onSaved={onSaved}
              onStatusChange={onStatusChange}
              onToggle={(methodKey, label, nextEnabled) => setPendingToggle({ methodKey, label, nextEnabled })}
              testResult={testResults[g.methodKey]}
              onTest={(methodKey, label) => setPendingTest({ methodKey, label })}
              health={g.methodKey === "bybit" ? data.bybitHealth : g.methodKey === "bybit_bsc" ? data.bybitBscHealth : undefined}
            />
          ))}

          <SaveConfirmDialog
            open={pendingToggle !== null}
            onOpenChange={(open) => { if (!open) setPendingToggle(null); }}
            title={
              pendingToggle
                ? `${pendingToggle.nextEnabled ? "Enable" : "Disable"} ${pendingToggle.label}?`
                : ""
            }
            description={
              pendingToggle?.nextEnabled
                ? "Customers will be able to pay with this gateway immediately."
                : "Customers will no longer be able to pay with this gateway."
            }
            confirmLabel={pendingToggle?.nextEnabled ? "Enable" : "Disable"}
            variant={pendingToggle?.nextEnabled ? "default" : "destructive"}
            successMessage="Payment method updated"
            onConfirm={async () => {
              if (!pendingToggle) return;
              await togglePayment.mutateAsync({
                method: pendingToggle.methodKey,
                enabled: pendingToggle.nextEnabled,
              });
            }}
          />

          <SaveConfirmDialog
            open={pendingTest !== null}
            onOpenChange={(open) => { if (!open) setPendingTest(null); }}
            title={pendingTest ? `Test the ${pendingTest.label} connection?` : ""}
            description="This checks whether the currently-saved credentials work, without changing anything."
            confirmLabel="Test"
            onConfirm={async () => {
              if (!pendingTest) return "";
              if (pendingTest.methodKey === "__telegram_bot_token__") {
                const result = await apiPost<TestResult>("/api/settings/telegram/test", { target: "bot_token" });
                setTestResults((prev) => ({ ...prev, __telegram_bot_token__: result }));
                return result.detail;
              }
              if (pendingTest.methodKey === "__telegram_join_channel__") {
                const result = await apiPost<TestResult>("/api/settings/telegram/test", { target: "join_gate_channel_id" });
                setTestResults((prev) => ({ ...prev, __telegram_join_channel__: result }));
                return result.detail;
              }
              if (pendingTest.methodKey === "__telegram_join_group__") {
                const result = await apiPost<TestResult>("/api/settings/telegram/test", { target: "join_gate_group_id" });
                setTestResults((prev) => ({ ...prev, __telegram_join_group__: result }));
                return result.detail;
              }
              if (pendingTest.methodKey === "__smtp__") {
                const result = await apiPost<TestResult>("/api/settings/smtp/test", {});
                setTestResults((prev) => ({ ...prev, __smtp__: result }));
                return result.detail;
              }
              return runTest(pendingTest.methodKey);
            }}
          />

          <SaveConfirmDialog
            open={restartConfirmOpen}
            onOpenChange={setRestartConfirmOpen}
            title="Restart the bot?"
            description="Active conversations may briefly disconnect while the process restarts."
            confirmLabel="Restart"
            variant="destructive"
            onConfirm={runRestart}
          />

          <SaveConfirmDialog
            open={importConfirmOpen}
            onOpenChange={(open) => { if (!open) setImportPreview(null); setImportConfirmOpen(open); }}
            title="Import configuration?"
            description={
              importPreview
                ? `This will update up to ${importPreview.count} setting${importPreview.count === 1 ? "" : "s"}. Secret fields and unrecognized keys are skipped automatically.`
                : ""
            }
            confirmLabel="Import"
            onConfirm={runImport}
          />

          {/* Other / catch-all for any future fields */}
          {otherVisible && (
            <Card id="settings-other">
              <CardHeader>
                <CardTitle as="h2">Other Settings</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {otherFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("Other Settings")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Exchange Rates */}
          {fxVisible && (
            <Card id="settings-exchange-rates">
              <CardHeader>
                <CardTitle as="h2">Exchange Rates</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-line">
                  {fxFields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      query={fieldQueryFor("Exchange Rates")}
                      onSaved={onSaved}
                      onStatusChange={onStatusChange}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-3">
                  <Button onClick={() => setFxConfirmOpen(true)} variant="outline">
                    Refresh USDT Rate
                  </Button>
                  {fxLastRefreshedAt && (
                    <span className="text-xs text-ink-soft">
                      Last synced {Math.max(1, Math.round((Date.now() - fxLastRefreshedAt) / 60000))} minute
                      {Math.max(1, Math.round((Date.now() - fxLastRefreshedAt) / 60000)) === 1 ? "" : "s"} ago
                    </span>
                  )}
                  <SaveConfirmDialog
                    open={fxConfirmOpen}
                    onOpenChange={setFxConfirmOpen}
                    title="Refresh the USDT exchange rate?"
                    description="Fetches the current market rate and applies it immediately."
                    confirmLabel="Refresh"
                    onConfirm={refreshFx}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Digiflazz (Top Up Game) */}
          {digiflazzVisible && (
            <Card id="settings-digiflazz">
              <CardHeader>
                <CardTitle as="h2">Digiflazz (Top Up Game)</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {digiflazzFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("Digiflazz (Top Up Game)")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                    selectOptions={field.key === "digiflazz_markup_type" ? DIGIFLAZZ_MARKUP_TYPE_OPTIONS : undefined}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!digiflazzFields.find((f) => f.key === "digiflazz_api_key")?.hasValue}
                  title={
                    digiflazzFields.find((f) => f.key === "digiflazz_api_key")?.hasValue
                      ? undefined
                      : "Add credentials above to test this connection."
                  }
                  onClick={() => setPendingTest({ methodKey: "digiflazz", label: "Digiflazz" })}
                >
                  Test Connection
                </Button>
                {testResults.digiflazz && (
                  <p className={`text-xs ${testResults.digiflazz.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.digiflazz.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* KokinPay (Nickname Check) — Task 7. Separate paid service from
              Digiflazz, so its own Card; no markup-rule section since this is
              a lookup-only service, not something priced/sold. */}
          {kokinpayVisible && (
            <Card id="settings-kokinpay">
              <CardHeader>
                <CardTitle as="h2">KokinPay (Nickname Check)</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {kokinpayFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("KokinPay (Nickname Check)")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!kokinpayFields.find((f) => f.key === "kokinpay_api_key")?.hasValue}
                  title={
                    kokinpayFields.find((f) => f.key === "kokinpay_api_key")?.hasValue
                      ? undefined
                      : "Add credentials above to test this connection."
                  }
                  onClick={() => setPendingTest({ methodKey: "kokinpay", label: "KokinPay" })}
                >
                  Test Connection
                </Button>
                {testResults.kokinpay && (
                  <p className={`text-xs ${testResults.kokinpay.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.kokinpay.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* VIP-Reseller (Region Check) — Region-check Task A. A second,
              independent lookup from KokinPay, used only to detect a buyer's
              account region on Mobile Legends lookups; its own Card, same
              reasoning as KokinPay above (not a checkout payment method). */}
          {vipresellerVisible && (
            <Card id="settings-vipreseller">
              <CardHeader>
                <CardTitle as="h2">VIP-Reseller (Region Check)</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {vipresellerFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("VIP-Reseller (Region Check)")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !vipresellerFields.find((f) => f.key === "vipreseller_api_id")?.hasValue ||
                    !vipresellerFields.find((f) => f.key === "vipreseller_api_key")?.hasValue
                  }
                  title={
                    vipresellerFields.find((f) => f.key === "vipreseller_api_id")?.hasValue &&
                    vipresellerFields.find((f) => f.key === "vipreseller_api_key")?.hasValue
                      ? undefined
                      : "Add credentials above to test this connection."
                  }
                  onClick={() => setPendingTest({ methodKey: "vipreseller", label: "VIP-Reseller" })}
                >
                  Test Connection
                </Button>
                {testResults.vipreseller && (
                  <p className={`text-xs ${testResults.vipreseller.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.vipreseller.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* MeloStore (Nickname Check) — multi-provider nickname check plan.
              A third, independent nickname-check provider alongside
              KokinPay/VIP-Reseller; its own Card, same reasoning as those two
              above (not a checkout payment method). Two required fields (API
              key + secret key), like VIP-Reseller. */}
          {melostoreVisible && (
            <Card id="settings-melostore">
              <CardHeader>
                <CardTitle as="h2">MeloStore (Nickname Check)</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {melostoreFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    query={fieldQueryFor("MeloStore (Nickname Check)")}
                    onSaved={onSaved}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </CardContent>
              <CardContent className="flex flex-wrap items-center gap-3 pt-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !melostoreFields.find((f) => f.key === "melostore_api_key")?.hasValue ||
                    !melostoreFields.find((f) => f.key === "melostore_secret_key")?.hasValue
                  }
                  title={
                    melostoreFields.find((f) => f.key === "melostore_api_key")?.hasValue &&
                    melostoreFields.find((f) => f.key === "melostore_secret_key")?.hasValue
                      ? undefined
                      : "Add credentials above to test this connection."
                  }
                  onClick={() => setPendingTest({ methodKey: "melostore", label: "MeloStore" })}
                >
                  Test Connection
                </Button>
                {testResults.melostore && (
                  <p className={`text-xs ${testResults.melostore.ok ? "text-grass-dark" : "text-rust"}`}>
                    {testResults.melostore.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Security */}
          {securityVisible && (
            <Card id="settings-security">
              <CardHeader>
                <CardTitle as="h2">Security</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">

                {/* Change Password */}
                <div>
                  <div className="text-sm font-medium text-ink mb-3">
                    Change Password
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setPwConfirmOpen(true);
                    }}
                    className="flex flex-col gap-2 max-w-xs"
                  >
                    <Input
                      type="password"
                      placeholder="Current password"
                      value={pwCurrent}
                      onChange={(e) => setPwCurrent(e.target.value)}
                      aria-label="Current password"
                      required
                    />
                    <Input
                      type="password"
                      placeholder="New password (min 8 chars)"
                      value={pwNew}
                      onChange={(e) => setPwNew(e.target.value)}
                      aria-label="New password"
                      required
                      minLength={8}
                    />
                    <Button type="submit" className="self-start">
                      Change Password
                    </Button>
                  </form>
                  <SaveConfirmDialog
                    open={pwConfirmOpen}
                    onOpenChange={setPwConfirmOpen}
                    title="Change your password?"
                    description="You'll need the new password next time you sign in."
                    confirmLabel="Change Password"
                    onConfirm={changePassword}
                  />
                </div>

                {/* Two-Factor Authentication */}
                <div>
                  <div className="text-sm font-medium text-ink mb-3">
                    Two-Factor Authentication
                  </div>
                  {tfaError && (
                    <p className="text-sm text-rust mb-2">{tfaError}</p>
                  )}

                  {!data.twoFaEnabled && !data.twoFaPending && (
                    <div>
                      <p className="text-sm text-ink-soft mb-3">
                        2FA is not enabled. Enable it for extra account security.
                      </p>
                      <Button
                        onClick={() => tfaAction("/api/settings/2fa/begin", {})}
                        disabled={tfaSaving}
                        variant="outline"
                      >
                        {tfaSaving ? "…" : "Enable 2FA"}
                      </Button>
                    </div>
                  )}

                  {data.twoFaPending && (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-ink-soft">
                        Add this secret to your authenticator app, then enter the generated code:
                      </p>
                      <code className="block rounded bg-sand px-2 py-1 text-sm font-mono break-all text-ink">
                        {data.twoFaPending.secret}
                      </code>
                      <p className="text-xs text-ink-soft break-all">
                        {data.twoFaPending.uri}
                      </p>
                      <div className="flex flex-wrap gap-2 items-center">
                        <Input
                          type="text"
                          placeholder="6-digit code"
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value)}
                          aria-label="6-digit authenticator code"
                          className="w-36"
                          maxLength={6}
                        />
                        <Button onClick={() => setTfaEnableConfirmOpen(true)} disabled={tfaSaving}>
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => tfaAction("/api/settings/2fa/cancel", {})}
                          disabled={tfaSaving}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {data.twoFaEnabled && !data.twoFaPending && (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-grass">2FA is currently enabled.</p>
                      <p className="text-sm text-ink-soft">
                        To disable, enter your password and a TOTP code:
                      </p>
                      <div className="flex flex-col gap-2 max-w-xs">
                        <Input
                          type="password"
                          placeholder="Current password"
                          value={disablePw}
                          onChange={(e) => setDisablePw(e.target.value)}
                          aria-label="Current password"
                        />
                        <Input
                          type="text"
                          placeholder="6-digit TOTP code"
                          value={disableTotp}
                          onChange={(e) => setDisableTotp(e.target.value)}
                          aria-label="6-digit TOTP code"
                          className="w-36"
                          maxLength={6}
                        />
                        <Button
                          variant="destructive"
                          onClick={() => setTfaDisableConfirmOpen(true)}
                          disabled={tfaSaving}
                          className="self-start"
                        >
                          Disable 2FA
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* Both rendered unconditionally — enabling/disabling 2FA
                      flips data.twoFaPending/twoFaEnabled on refetch, which
                      would otherwise unmount these mid-animation and cut off
                      the checkmark. */}
                  <SaveConfirmDialog
                    open={tfaEnableConfirmOpen}
                    onOpenChange={setTfaEnableConfirmOpen}
                    title="Enable two-factor authentication?"
                    description="You'll need your authenticator app's code every time you sign in from now on."
                    confirmLabel="Enable"
                    onConfirm={enableTwoFa}
                  />
                  <SaveConfirmDialog
                    open={tfaDisableConfirmOpen}
                    onOpenChange={setTfaDisableConfirmOpen}
                    title="Disable two-factor authentication?"
                    description="Your account will only be protected by your password after this."
                    confirmLabel="Disable"
                    variant="destructive"
                    onConfirm={disableTwoFa}
                  />
                </div>

              </CardContent>
            </Card>
          )}

        </div>
      </div>
    </PageLayout>
  );
}
