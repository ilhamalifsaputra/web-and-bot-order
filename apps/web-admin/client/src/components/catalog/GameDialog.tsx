/**
 * Create a new Game. Editing an existing game's own fields happens inline on
 * GameDetailPage instead (matching ProductDetailPage's own edit-in-place
 * card, rather than CategoryDialog's create+edit-in-one-dialog shape) — this
 * dialog only ever creates.
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
import { apiPost } from "../../api/client";

export function GameDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [nicknameSupported, setNicknameSupported] = useState(true);
  const [requiresZone, setRequiresZone] = useState(false);
  const [requiresServer, setRequiresServer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && slug.trim() !== "";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/games", {
        slug: slug.trim(),
        name: name.trim(),
        category: category.trim() || null,
        nicknameSupported,
        requiresZone,
        requiresServer,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create game.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New game</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="game-name">Name</Label>
            <Input id="game-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="game-slug">Slug</Label>
            <Input
              id="game-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. mobile-legends"
            />
          </div>
          <div>
            <Label htmlFor="game-category">Category</Label>
            <Input
              id="game-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. battle_royale"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="game-nickname">Nickname check supported</Label>
            <Switch id="game-nickname" checked={nicknameSupported} onCheckedChange={setNicknameSupported} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="game-zone">Requires zone</Label>
            <Switch id="game-zone" checked={requiresZone} onCheckedChange={setRequiresZone} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="game-server">Requires server</Label>
            <Switch id="game-server" checked={requiresServer} onCheckedChange={setRequiresServer} />
          </div>
          {error && <p className="text-sm text-rust">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
