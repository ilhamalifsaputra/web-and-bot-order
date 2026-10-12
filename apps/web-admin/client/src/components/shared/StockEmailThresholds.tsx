import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Thresholds { critical: number; recovery: number }

function ThresholdForm({ denominationId, initial }: { denominationId: number; initial: Thresholds }) {
  const client = useQueryClient();
  const [critical, setCritical] = useState(String(initial.critical));
  const [recovery, setRecovery] = useState(String(initial.recovery));
  const valid = Number.isInteger(Number(critical)) && Number(critical) >= 0 && Number.isInteger(Number(recovery)) && Number(recovery) > Number(critical);
  const save = useMutation({ mutationFn: () => apiPost(`/api/settings/email-notifications/inventory/${denominationId}`, { critical: Number(critical), recovery: Number(recovery) }), onSuccess: () => { void client.invalidateQueries({ queryKey: ["stock-email-thresholds", denominationId] }); } });
  return <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate(); }}>
    <div><label htmlFor={`critical-${denominationId}`} className="text-sm font-medium text-ink">Critical stock threshold</label><Input id={`critical-${denominationId}`} type="number" min={0} step={1} required value={critical} onChange={(event) => setCritical(event.target.value)} /></div>
    <div><label htmlFor={`recovery-${denominationId}`} className="text-sm font-medium text-ink">Recovery stock threshold</label><Input id={`recovery-${denominationId}`} type="number" min={Number(critical) + 1} step={1} required value={recovery} onChange={(event) => setRecovery(event.target.value)} /></div>
    <p className="text-xs text-ink-soft sm:col-span-2">Critical and out-of-stock alerts follow available local stock. Recovery must exceed the critical threshold. Enable the email events in Email Notifications.</p>
    {save.isError && <p role="alert" className="text-xs text-rust sm:col-span-2">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-xs text-grass-dark">Thresholds saved.</p>}
    <Button type="submit" className="justify-self-start" disabled={save.isPending || !valid}>{save.isPending ? "Saving…" : "Save stock thresholds"}</Button>
  </form>;
}

export function StockEmailThresholds({ denominationId }: { denominationId: number }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["stock-email-thresholds", denominationId], queryFn: () => apiGet<Thresholds>(`/api/settings/email-notifications/inventory/${denominationId}`), enabled: open });
  return <Card className="mb-6"><CardHeader><CardTitle as="h2">Stock email alerts</CardTitle></CardHeader><CardContent>
    {!open && <Button variant="outline" onClick={() => setOpen(true)}>Configure stock email thresholds</Button>}
    {open && query.isPending && <p role="status" className="text-sm text-ink-soft">Loading thresholds…</p>}
    {query.isError && <p role="alert" className="text-sm text-rust">{query.error.message}</p>}
    {query.data && <ThresholdForm denominationId={denominationId} initial={query.data} />}
  </CardContent></Card>;
}
