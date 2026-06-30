import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

interface SettingsField {
  key: string;
  label: string;
  secret: boolean;
  hasValue: boolean;
  value: string;
  needsRestart: boolean;
}

interface PayMethodState {
  enabled: boolean;
  configured: boolean;
}

interface SettingsData {
  fields: SettingsField[];
  payMethodState: Record<string, PayMethodState>;
  bybitHealth: unknown;
  bybitBscHealth: unknown;
  isOwner: boolean;
  twoFaEnabled: boolean;
  twoFaPending: { secret: string; uri: string } | null;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  tokopay: "TokoPay",
  paydisini: "PayDisini",
  nowpayments: "NOWPayments",
  bybit: "Bybit",
  bybit_bsc: "Bybit BSC",
  binance_internal: "Binance Internal Transfer",
};

// Field groupings — must match the server-side EDITABLE keys exactly.
const BRANDING_KEYS = new Set([
  "shop_name",
  "shop_tagline",
  "welcome",
  "banner_image",
  "support_contact",
  "support_whatsapp",
]);

const STORE_KEYS = new Set([
  "min_order_amount",
  "order_expiry_minutes",
  "stock_low_threshold",
]);

const TELEGRAM_KEYS = new Set([
  "bot_token",
  "bot_username",
  "notif_bot_token",
  "public_channel_id",
]);

const FX_KEYS = new Set([
  "usd_idr_rate",
  "usd_idr_rate_auto",
  "usd_idr_rate_rounding",
]);

const PAY_CRED_KEYS = new Set([
  // TokoPay
  "tokopay_merchant_id",
  "tokopay_secret",
  "tokopay_enabled",
  "tokopay_min_amount",
  // PayDisini
  "paydisini_userkey",
  "paydisini_apikey",
  "paydisini_enabled",
  "paydisini_default_channel",
  "paydisini_min_amount",
  // NOWPayments
  "nowpayments_api_key",
  "nowpayments_ipn_secret",
  "nowpayments_enabled",
  "nowpayments_pay_currency",
  "nowpayments_min_amount",
  // Bybit
  "bybit_uid",
  "bybit_api_key",
  "bybit_api_secret",
  "bybit_enabled",
  "bybit_min_amount",
  // Bybit BSC
  "bybit_bsc_deposit_address",
  "bybit_bsc_enabled",
  "bybit_bsc_min_amount",
  "bscscan_api_key",
  "bybit_bsc_required_confirmations",
  // Binance Internal Transfer
  "binance_receive_uid",
  "binance_api_key",
  "binance_api_secret",
  "binance_internal_enabled",
  "binance_internal_min_amount",
]);

const ALL_GROUPED_KEYS = new Set([
  ...BRANDING_KEYS,
  ...STORE_KEYS,
  ...TELEGRAM_KEYS,
  ...FX_KEYS,
  ...PAY_CRED_KEYS,
]);

function fieldGroup(fields: SettingsField[], keys: Set<string>): SettingsField[] {
  return fields.filter((f) => keys.has(f.key));
}

function fieldsOther(fields: SettingsField[]): SettingsField[] {
  return fields.filter((f) => !ALL_GROUPED_KEYS.has(f.key));
}

function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      return res.json() as Promise<SettingsData>;
    },
  });
}

function FieldRow({ field, onSaved }: { field: SettingsField; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/settings/edit", { key: field.key, value });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-start justify-between py-3">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm font-medium text-ink">
          {field.label}
          {field.needsRestart && (
            <span className="text-xs text-ink-soft ml-2">(restart required)</span>
          )}
        </div>
        {!editing && (
          <div className="mt-1 text-xs text-ink-soft">
            {field.secret ? (
              field.hasValue ? "••••••••" : <em className="text-ink-soft">not set</em>
            ) : (
              field.value || <em className="text-ink-soft">not set</em>
            )}
          </div>
        )}
        {editing && (
          <div className="mt-2 flex flex-wrap gap-2 items-center">
            <Input
              type={field.secret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="w-full max-w-sm"
            />
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue(field.value);
                setError(null);
              }}
            >
              Cancel
            </Button>
            {error && <p className="text-xs text-rust">{error}</p>}
          </div>
        )}
      </div>
      {!editing && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(true);
            setValue(field.value);
          }}
        >
          Edit
        </Button>
      )}
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useSettings();

  // Password change
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  // 2FA
  const [totpCode, setTotpCode] = useState("");
  const [tfaError, setTfaError] = useState<string | null>(null);
  const [tfaSaving, setTfaSaving] = useState(false);
  const [disablePw, setDisablePw] = useState("");
  const [disableTotp, setDisableTotp] = useState("");

  // FX refresh
  const [fxStatus, setFxStatus] = useState<string | null>(null);
  const [fxRefreshing, setFxRefreshing] = useState(false);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["settings"] }); };

  async function refreshFx() {
    setFxRefreshing(true);
    setFxStatus(null);
    try {
      const result = await apiPost<{ ok: boolean; status: string; rate: string }>(
        "/api/settings/fx/refresh",
        {},
      );
      setFxStatus(`Rate updated to ${result.rate} (${result.status})`);
      invalidate();
    } catch (e) {
      setFxStatus(e instanceof Error ? e.message : "Failed to refresh rate");
    } finally {
      setFxRefreshing(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSaving(true);
    setPwError(null);
    setPwOk(false);
    try {
      await apiPost("/api/settings/password", {
        current_password: pwCurrent,
        new_password: pwNew,
      });
      setPwOk(true);
      setPwCurrent("");
      setPwNew("");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwSaving(false);
    }
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

  const togglePayment = useMutation({
    mutationFn: ({ method, enabled }: { method: string; enabled: boolean }) =>
      apiPost("/api/settings/payments/toggle", { method, enabled: enabled ? "true" : "false" }),
    onSuccess: () => { invalidate(); },
  });

  return (
    <PageLayout title="Settings">
      <PageHeader title="Settings" />
      {isLoading && <p className="text-ink-soft">Loading settings…</p>}
      {isError && <p className="text-rust">Failed to load settings.</p>}

      {data && (
        <div className="flex flex-col gap-6 max-w-2xl">

          {/* General */}
          {fieldGroup(data.fields, BRANDING_KEYS).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>General</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldGroup(data.fields, BRANDING_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Store */}
          {fieldGroup(data.fields, STORE_KEYS).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Store</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldGroup(data.fields, STORE_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Telegram & Bot */}
          {fieldGroup(data.fields, TELEGRAM_KEYS).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Telegram &amp; Bot</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldGroup(data.fields, TELEGRAM_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Payment Credentials */}
          {fieldGroup(data.fields, PAY_CRED_KEYS).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Payment Credentials</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldGroup(data.fields, PAY_CRED_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Other / catch-all for any future fields */}
          {fieldsOther(data.fields).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Other Settings</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldsOther(data.fields).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Exchange Rates */}
          <Card>
            <CardHeader>
              <CardTitle>Exchange Rates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-line">
                {fieldGroup(data.fields, FX_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </div>
              <div className="flex items-center gap-3 pt-3">
                <Button
                  onClick={refreshFx}
                  disabled={fxRefreshing}
                  variant="outline"
                >
                  {fxRefreshing ? "Refreshing…" : "Refresh USDT Rate"}
                </Button>
                {fxStatus && (
                  <span className="text-sm text-ink-soft">{fxStatus}</span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Payment Methods */}
          <Card>
            <CardHeader>
              <CardTitle>Payment Methods</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-line">
              {Object.entries(data.payMethodState).map(([method, state]) => (
                <div
                  key={method}
                  className="flex items-center justify-between py-3"
                >
                  <div>
                    <span className="text-sm font-medium text-ink">
                      {PAYMENT_METHOD_LABELS[method] ?? method}
                    </span>
                    {!state.configured && (
                      <span className="text-xs text-amberx ml-2">
                        not configured
                      </span>
                    )}
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={state.enabled}
                      onChange={(e) =>
                        togglePayment.mutate({ method, enabled: e.target.checked })
                      }
                    />
                    <span className="text-sm text-ink-soft">
                      {state.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </label>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Security */}
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">

              {/* Change Password */}
              <div>
                <div className="text-sm font-medium text-ink mb-3">
                  Change Password
                </div>
                <form
                  onSubmit={changePassword}
                  className="flex flex-col gap-2 max-w-xs"
                >
                  {pwError && (
                    <p className="text-sm text-rust">{pwError}</p>
                  )}
                  {pwOk && (
                    <p className="text-sm text-grass">
                      Password changed successfully.
                    </p>
                  )}
                  <Input
                    type="password"
                    placeholder="Current password"
                    value={pwCurrent}
                    onChange={(e) => setPwCurrent(e.target.value)}
                    required
                  />
                  <Input
                    type="password"
                    placeholder="New password (min 8 chars)"
                    value={pwNew}
                    onChange={(e) => setPwNew(e.target.value)}
                    required
                    minLength={8}
                  />
                  <Button
                    type="submit"
                    disabled={pwSaving}
                    className="self-start"
                  >
                    {pwSaving ? "Saving…" : "Change Password"}
                  </Button>
                </form>
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
                        className="w-36"
                        maxLength={6}
                      />
                      <Button
                        onClick={() =>
                          tfaAction("/api/settings/2fa/enable", { totp_code: totpCode })
                        }
                        disabled={tfaSaving}
                      >
                        {tfaSaving ? "…" : "Confirm"}
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
                      />
                      <Input
                        type="text"
                        placeholder="6-digit TOTP code"
                        value={disableTotp}
                        onChange={(e) => setDisableTotp(e.target.value)}
                        className="w-36"
                        maxLength={6}
                      />
                      <Button
                        variant="destructive"
                        onClick={() =>
                          tfaAction("/api/settings/2fa/disable", {
                            current_password: disablePw,
                            totp_code: disableTotp,
                          })
                        }
                        disabled={tfaSaving}
                        className="self-start"
                      >
                        {tfaSaving ? "…" : "Disable 2FA"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

            </CardContent>
          </Card>

        </div>
      )}
    </PageLayout>
  );
}
