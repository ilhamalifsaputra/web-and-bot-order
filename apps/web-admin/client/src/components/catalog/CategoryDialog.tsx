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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { apiPatch, apiPost } from "../../api/client";
import type { CategoryRow } from "../../api/catalog";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      emoji: emoji.trim() || null,
      description: description.trim() || null,
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
          <div>
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="cat-emoji">Emoji</Label>
            <Input
              id="cat-emoji"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              className="max-w-[100px]"
            />
          </div>
          <div>
            <Label htmlFor="cat-desc">Description</Label>
            <Textarea
              id="cat-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
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
