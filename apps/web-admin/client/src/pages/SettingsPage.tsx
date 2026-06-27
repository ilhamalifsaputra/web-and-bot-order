import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
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
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: "1px solid #eee" }}>
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 500 }}>{field.label}</span>
        {field.needsRestart && (
          <span style={{ color: "#888", fontSize: 12, marginLeft: 6 }}>(restart required)</span>
        )}
        {!editing && (
          <div style={{ fontSize: 13, color: "#555", marginTop: 2 }}>
            {field.secret ? (
              field.hasValue ? "••••••••" : <em style={{ color: "#aaa" }}>not set</em>
            ) : (
              field.value || <em style={{ color: "#aaa" }}>not set</em>
            )}
          </div>
        )}
        {editing && (
          <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input
              style={{ padding: "4px 8px", flex: 1, minWidth: 160 }}
              type={field.secret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <button onClick={save} disabled={saving} style={{ padding: "4px 10px" }}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setValue(field.value);
                setError(null);
              }}
              style={{ padding: "4px 10px" }}
            >
              Cancel
            </button>
            {error && <p style={{ color: "red", margin: 0, fontSize: 12 }}>{error}</p>}
          </div>
        )}
      </div>
      {!editing && (
        <button
          onClick={() => {
            setEditing(true);
            setValue(field.value);
          }}
          style={{ padding: "3px 8px", fontSize: 12 }}
        >
          Edit
        </button>
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
      {isLoading && <p>Loading settings…</p>}
      {isError && <p style={{ color: "red" }}>Failed to load settings.</p>}

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 700 }}>
          {/* Configuration fields */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Configuration</h2>
            <div>
              {data.fields.map((field) => (
                <FieldRow key={field.key} field={field} onSaved={invalidate} />
              ))}
            </div>
          </section>

          {/* Exchange rate */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Exchange Rate</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={refreshFx}
                disabled={fxRefreshing}
                style={{ padding: "6px 14px" }}
              >
                {fxRefreshing ? "Refreshing…" : "Refresh USDT Rate"}
              </button>
              {fxStatus && <span style={{ fontSize: 13 }}>{fxStatus}</span>}
            </div>
          </section>

          {/* Payment methods */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Payment Methods</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {Object.entries(data.payMethodState).map(([method, state]) => (
                <div
                  key={method}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "6px 0",
                    borderBottom: "1px solid #eee",
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {PAYMENT_METHOD_LABELS[method] ?? method}
                    {!state.configured && (
                      <span style={{ color: "#f59e0b", fontSize: 12, marginLeft: 8 }}>
                        not configured
                      </span>
                    )}
                  </span>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={state.enabled}
                      onChange={(e) =>
                        togglePayment.mutate({ method, enabled: e.target.checked })
                      }
                    />
                    {state.enabled ? "Enabled" : "Disabled"}
                  </label>
                </div>
              ))}
            </div>
          </section>

          {/* Password */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Change Password</h2>
            <form
              onSubmit={changePassword}
              style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}
            >
              {pwError && <p style={{ color: "red", margin: 0 }}>{pwError}</p>}
              {pwOk && <p style={{ color: "green", margin: 0 }}>Password changed successfully.</p>}
              <input
                type="password"
                placeholder="Current password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                style={{ padding: "6px 10px" }}
                required
              />
              <input
                type="password"
                placeholder="New password (min 8 chars)"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                style={{ padding: "6px 10px" }}
                required
                minLength={8}
              />
              <button
                type="submit"
                disabled={pwSaving}
                style={{ padding: "6px 14px", alignSelf: "flex-start" }}
              >
                {pwSaving ? "Saving…" : "Change Password"}
              </button>
            </form>
          </section>

          {/* 2FA */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              Two-Factor Authentication
            </h2>
            {tfaError && <p style={{ color: "red", marginBottom: 8 }}>{tfaError}</p>}

            {!data.twoFaEnabled && !data.twoFaPending && (
              <div>
                <p style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
                  2FA is not enabled. Enable it for extra account security.
                </p>
                <button
                  onClick={() => tfaAction("/api/settings/2fa/begin", {})}
                  disabled={tfaSaving}
                  style={{ padding: "6px 14px" }}
                >
                  {tfaSaving ? "…" : "Enable 2FA"}
                </button>
              </div>
            )}

            {data.twoFaPending && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: 13 }}>
                  Add this secret to your authenticator app, then enter the generated code:
                </p>
                <code
                  style={{
                    background: "#f3f3f3",
                    padding: "4px 8px",
                    borderRadius: 4,
                    fontSize: 13,
                    wordBreak: "break-all",
                  }}
                >
                  {data.twoFaPending.secret}
                </code>
                <p style={{ fontSize: 12, color: "#666", wordBreak: "break-all" }}>
                  {data.twoFaPending.uri}
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="text"
                    placeholder="6-digit code"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    style={{ padding: "6px 10px", width: 140 }}
                    maxLength={6}
                  />
                  <button
                    onClick={() =>
                      tfaAction("/api/settings/2fa/enable", { totp_code: totpCode })
                    }
                    disabled={tfaSaving}
                    style={{ padding: "6px 14px" }}
                  >
                    {tfaSaving ? "…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => tfaAction("/api/settings/2fa/cancel", {})}
                    disabled={tfaSaving}
                    style={{ padding: "6px 10px", color: "#666" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {data.twoFaEnabled && !data.twoFaPending && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: 13, color: "#16a34a" }}>2FA is currently enabled.</p>
                <p style={{ fontSize: 13, color: "#555" }}>
                  To disable, enter your password and a TOTP code:
                </p>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 280 }}
                >
                  <input
                    type="password"
                    placeholder="Current password"
                    value={disablePw}
                    onChange={(e) => setDisablePw(e.target.value)}
                    style={{ padding: "6px 10px" }}
                  />
                  <input
                    type="text"
                    placeholder="6-digit TOTP code"
                    value={disableTotp}
                    onChange={(e) => setDisableTotp(e.target.value)}
                    style={{ padding: "6px 10px", width: 140 }}
                    maxLength={6}
                  />
                  <button
                    onClick={() =>
                      tfaAction("/api/settings/2fa/disable", {
                        current_password: disablePw,
                        totp_code: disableTotp,
                      })
                    }
                    disabled={tfaSaving}
                    style={{ padding: "6px 14px", alignSelf: "flex-start", color: "red" }}
                  >
                    {tfaSaving ? "…" : "Disable 2FA"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </PageLayout>
  );
}
