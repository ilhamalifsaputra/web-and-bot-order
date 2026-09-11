/**
 * Create or edit one category. The same fields either way — passing a
 * `category` switches it to edit mode. Sort order is deliberately absent:
 * ordering is set with the up/down buttons on the Categories page, not by
 * typing a number here.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { apiPatch, apiPost } from "../../api/client";
import type { CategoryRow } from "../../api/catalog";

// Sentinel for "no group set" — shadcn's Select rejects an empty-string item
// value, so a real value stands in for it, matching TicketDetailPage.tsx's
// UNCATEGORIZED convention for its own nullable category Select.
const NO_GROUP = "_none_";

export function CategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  /** Omit to create a new category. */
  category?: CategoryRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = category != null;
  const [name, setName] = useState(category?.name ?? "");
  const [emoji, setEmoji] = useState(category?.emoji ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [checkoutFlow, setCheckoutFlow] = useState<"catalog" | "instant">(
    category?.checkoutFlow ?? "catalog",
  );
  const [group, setGroup] = useState<string>(category?.group ?? NO_GROUP);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      emoji: emoji.trim() || null,
      description: description.trim() || null,
      checkoutFlow,
      group: group === NO_GROUP ? null : group,
    };
    try {
      if (editing) {
        await apiPatch(`/api/catalog/categories/${category.id}`, body);
      } else {
        await apiPost("/api/catalog/categories", body);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : `Failed to ${editing ? "save" : "create"} category.`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-emoji">Emoji</Label>
            <Input
              id="cat-emoji"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              className="max-w-[100px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-desc">Description</Label>
            <Textarea
              id="cat-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label>Checkout flow</Label>
            <RadioGroup
              className="mt-2"
              value={checkoutFlow}
              onValueChange={(v) => setCheckoutFlow(v as "catalog" | "instant")}
            >
              <label
                htmlFor="cat-checkout-flow-catalog"
                className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer transition-colors hover:border-pine/50 has-[[data-state=checked]]:border-pine has-[[data-state=checked]]:bg-pine-tint"
              >
                <RadioGroupItem id="cat-checkout-flow-catalog" value="catalog" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-ink">Catalog</span>
                  <span className="block text-xs text-ink-soft">
                    Standard multi-page shop flow (browse → cart → checkout).
                  </span>
                </span>
              </label>
              <label
                htmlFor="cat-checkout-flow-instant"
                className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer transition-colors hover:border-pine/50 has-[[data-state=checked]]:border-pine has-[[data-state=checked]]:bg-pine-tint"
              >
                <RadioGroupItem id="cat-checkout-flow-instant" value="instant" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-ink">Instant</span>
                  <span className="block text-xs text-ink-soft">
                    Single-page instant-buy flow for Digiflazz-backed top-up categories.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-group">Group</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger id="cat-group" aria-label="Group">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>Not set</SelectItem>
                <SelectItem value="GAME_TOPUP">🎮 Game Top Up</SelectItem>
                <SelectItem value="PREMIUM_APPS">💎 Premium Apps</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {editing && (
            <p className="text-sm text-ink-soft">
              Web address: <span className="font-mono text-ink">/c/{category.slug}</span> — this
              stays the same when you rename the category, so links you've already shared
              keep working.
            </p>
          )}
          {error && <p className="text-sm text-rust">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
