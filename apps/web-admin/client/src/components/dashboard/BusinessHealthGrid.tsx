import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { UrgencyDot } from "../shared/UrgencyDot";
import { useHealth } from "../../hooks/useHealth";
import type { HealthLevel, HealthStatus } from "../../api/types";

const SERVICES: Array<{ key: keyof HealthStatus; label: string }> = [
  { key: "telegramBot", label: "Telegram Bot" },
  { key: "binance", label: "Binance" },
  { key: "bybit", label: "Bybit" },
  { key: "tokopay", label: "TokoPay" },
  { key: "paydisini", label: "PayDisini" },
  { key: "nowpayments", label: "NOWPayments" },
];

const DOT: Record<HealthLevel, "ok" | "warn" | "critical" | "idle"> = {
  green: "ok",
  yellow: "warn",
  red: "critical",
  unmonitored: "idle",
};

const LABEL: Record<HealthLevel, string> = {
  green: "Healthy",
  yellow: "Warning",
  red: "Critical",
  unmonitored: "Unmonitored",
};

export function BusinessHealthGrid() {
  const { data, isLoading, isError } = useHealth();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Business Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load service health.</p>}
        {data && (
          <ul className="flex flex-col divide-y divide-line">
            {SERVICES.map((s) => {
              const level = data[s.key];
              return (
                <li key={s.key} className="flex items-center justify-between py-2">
                  <span className="text-sm text-ink">{s.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
                    <UrgencyDot level={DOT[level]} />
                    {LABEL[level]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
