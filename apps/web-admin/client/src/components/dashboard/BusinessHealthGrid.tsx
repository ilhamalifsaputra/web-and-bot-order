import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { UrgencyDot } from "../shared/UrgencyDot";
import { useHealth } from "../../hooks/useHealth";
import { HEALTH_DOT } from "../../lib/healthDot";
import type { HealthLevel, HealthStatus } from "../../api/types";

const SERVICES: Array<{ key: keyof HealthStatus; label: string }> = [
  { key: "telegramBot", label: "Telegram Bot" },
  { key: "binance", label: "Binance" },
  { key: "bybit", label: "Bybit" },
  { key: "bybitBsc", label: "Bybit BSC" },
  { key: "tokopay", label: "TokoPay" },
  { key: "paydisini", label: "PayDisini" },
  { key: "nowpayments", label: "NOWPayments" },
  { key: "digiflazzCatalogSync", label: "Digiflazz Catalog Sync" },
];

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
        {/* F-010: real heading, same level as "Operation Center" (<h2>). */}
        <CardTitle as="h2">Business Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load service health.</p>}
        {data && (
          <ul className="flex flex-col divide-y divide-line">
            {SERVICES.map((s) => {
              const { status, detail } = data[s.key];
              return (
                <li key={s.key} className="flex items-center justify-between py-2">
                  <span className="text-sm text-ink">{s.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft" title={detail}>
                    <UrgencyDot level={HEALTH_DOT[status]} />
                    {LABEL[status]}
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
