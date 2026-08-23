/**
 * Add or edit one ProviderGameMapping row for a Game (Task 10's
 * `POST /api/games/:id/mappings` upsert route, keyed on (gameId, provider)).
 * The provider dropdown is locked while editing an existing mapping —
 * changing it wouldn't rename the row, it would upsert a *different*
 * provider's mapping (possibly overwriting one that already exists), which
 * is never what "edit this row" means. Creating offers only the providers
 * this game doesn't already have a mapping for, for the same reason.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiPost } from "../../api/client";
import { PROVIDERS, PROVIDER_LABELS, type ProviderId, type ProviderMappingRow } from "../../api/games";

export function MappingDialog({
  gameId,
  mapping,
  existingProviders,
  onClose,
  onSaved,
}: {
  gameId: string;
  /** Omit (or null) to add a new mapping. */
  mapping?: ProviderMappingRow | null;
  /** Providers this game already has a mapping for — a create dialog only
   *  offers the remaining ones. */
  existingProviders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = mapping != null;
  const available = editing
    ? PROVIDERS
    : PROVIDERS.filter((p) => !existingProviders.includes(p));
  const [provider, setProvider] = useState<ProviderId>(
    (mapping?.provider as ProviderId | undefined) ?? available[0] ?? PROVIDERS[0],
  );
  const [code, setCode] = useState(mapping?.providerGameCode ?? "");
  const [enabled, setEnabled] = useState(mapping?.enabled ?? true);
  const [priority, setPriority] = useState(String(mapping?.priority ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priorityNumber = Number(priority);
  const canSave = code.trim() !== "" && priority.trim() !== "" && Number.isInteger(priorityNumber);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/games/${gameId}/mappings`, {
        provider,
        providerGameCode: code.trim(),
        enabled,
        priority: priorityNumber,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${editing ? "save" : "add"} the mapping.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit mapping" : "Add mapping"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="mapping-provider">Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as ProviderId)} disabled={editing}>
              <SelectTrigger id="mapping-provider" aria-label="Provider">
                <SelectValue placeholder="Pick a provider" />
              </SelectTrigger>
              <SelectContent>
                {(editing ? PROVIDERS : available).map((p) => (
                  <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="mapping-code">Provider game code</Label>
            <Input id="mapping-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="mapping-priority">Priority</Label>
            <Input
              id="mapping-priority"
              type="number"
              className="max-w-[120px]"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="mapping-enabled">Enabled</Label>
            <Switch id="mapping-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          {error && <p className="text-sm text-rust">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? "Saving…" : editing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
