import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { MappingDialog } from "../components/catalog/MappingDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AlertCircle, SquarePen, Save, X, Plus, Trash2, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import {
  useGame,
  gameQueryKey,
  GAMES_QUERY_KEY,
  PROVIDERS,
  providerLabel,
  type ProviderMappingRow,
} from "../api/games";
import { describeError } from "../lib/errorMessages";

export function GameDetailPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isError, refetch } = useGame(gameId ?? "");

  const [editingGame, setEditingGame] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [slugDraft, setSlugDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [nicknameSupportedDraft, setNicknameSupportedDraft] = useState(true);
  const [requiresZoneDraft, setRequiresZoneDraft] = useState(false);
  const [requiresServerDraft, setRequiresServerDraft] = useState(false);
  const [isActiveDraft, setIsActiveDraft] = useState(true);
  const [savingGame, setSavingGame] = useState(false);
  const [gameError, setGameError] = useState<string | null>(null);

  const [mappingDialog, setMappingDialog] = useState<{ mapping: ProviderMappingRow | null } | null>(null);
  const [pendingDeleteMapping, setPendingDeleteMapping] = useState<ProviderMappingRow | null>(null);
  const [togglingMapping, setTogglingMapping] = useState<Set<number>>(new Set());

  const [pendingDeleteGame, setPendingDeleteGame] = useState(false);
  const [blockedDelete, setBlockedDelete] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: gameQueryKey(gameId ?? "") });

  async function saveGame() {
    setSavingGame(true);
    setGameError(null);
    try {
      await apiPost(`/api/games/${gameId}/edit`, {
        name: nameDraft.trim(),
        slug: slugDraft.trim(),
        category: categoryDraft.trim() || null,
        nicknameSupported: nicknameSupportedDraft,
        requiresZone: requiresZoneDraft,
        requiresServer: requiresServerDraft,
        isActive: isActiveDraft,
      });
      setEditingGame(false);
      await invalidate();
      // The list page's provider-mapping counts / name / slug columns read
      // the shared ["games"] query — keep them in sync too.
      await queryClient.invalidateQueries({ queryKey: GAMES_QUERY_KEY });
    } catch (e) {
      setGameError(e instanceof Error ? e.message : "Failed to save game.");
    } finally {
      setSavingGame(false);
    }
  }

  async function toggleMappingEnabled(mapping: ProviderMappingRow, enabled: boolean) {
    setTogglingMapping((s) => new Set([...s, mapping.id]));
    try {
      await apiPost(`/api/games/${gameId}/mappings`, {
        provider: mapping.provider,
        providerGameCode: mapping.providerGameCode,
        enabled,
        priority: mapping.priority,
      });
      await invalidate();
    } catch (e) {
      toast.error(describeError(e, "Failed to update the mapping."));
    } finally {
      setTogglingMapping((s) => {
        const n = new Set(s);
        n.delete(mapping.id);
        return n;
      });
    }
  }

  async function deleteMapping(mapping: ProviderMappingRow) {
    try {
      await apiPost(`/api/games/${gameId}/mappings/${mapping.id}/delete`, {});
      await invalidate();
      toast.success(`Removed the ${providerLabel(mapping.provider)} mapping.`);
    } catch (e) {
      toast.error(describeError(e, "Failed to delete the mapping."));
    }
  }

  async function deleteGame() {
    try {
      await apiPost(`/api/games/${gameId}/delete`, {});
      await queryClient.invalidateQueries({ queryKey: GAMES_QUERY_KEY });
      toast.success("Game deleted.");
      navigate("/games");
    } catch (e) {
      // The server refuses a game still linked to any product, and answers
      // with a sentence naming it — show that instead of a generic failure,
      // matching CategoriesPage's same blocked-delete pattern.
      setBlockedDelete(e instanceof Error ? e.message : "Failed to delete the game.");
    }
  }

  if (isError) {
    return (
      <PageLayout title="Game Detail">
        <EmptyState
          icon={AlertCircle}
          title="Failed to load game"
          description="An error occurred while loading the game. Please try again."
          action={{ label: "Retry", onClick: () => void refetch() }}
        />
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Game Detail">
        <p>Loading…</p>
      </PageLayout>
    );
  }

  const { game } = data;
  const mappedProviders = game.providerMappings.map((m) => m.provider);
  const canAddMapping = mappedProviders.length < PROVIDERS.length;

  return (
    <PageLayout title={game.name}>
      <PageHeader
        title={game.name}
        breadcrumb={[{ label: "Games", href: "/games" }]}
        actions={
          !editingGame && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNameDraft(game.name);
                  setSlugDraft(game.slug);
                  setCategoryDraft(game.category ?? "");
                  setNicknameSupportedDraft(game.nicknameSupported);
                  setRequiresZoneDraft(game.requiresZone);
                  setRequiresServerDraft(game.requiresServer);
                  setIsActiveDraft(game.isActive);
                  setEditingGame(true);
                }}
              >
                <SquarePen className="h-4 w-4" />
                Edit game
              </Button>
              <Button variant="ghost" size="sm" className="text-rust" onClick={() => setPendingDeleteGame(true)}>
                <Trash2 className="h-4 w-4" />
                Delete game
              </Button>
            </div>
          )
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <span className="text-ink-soft">
            Slug: <span className="font-mono text-ink">{game.slug}</span>
          </span>
          <span className="text-ink-soft">
            Category: <span className="text-ink">{game.category ?? "—"}</span>
          </span>
          <span className="text-ink-soft">{game.isActive ? "Active" : "Inactive"}</span>
        </CardContent>
      </Card>

      {editingGame && (
        <Card className="mb-4 max-w-lg">
          <CardContent className="flex flex-col gap-3">
            <div>
              <Label htmlFor="game-name-edit">Name</Label>
              <Input id="game-name-edit" className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="game-slug-edit">Slug</Label>
              <Input id="game-slug-edit" className="mt-1" value={slugDraft} onChange={(e) => setSlugDraft(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="game-category-edit">Category</Label>
              <Input id="game-category-edit" className="mt-1" value={categoryDraft} onChange={(e) => setCategoryDraft(e.target.value)} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="game-nickname-edit">Nickname check supported</Label>
              <Switch id="game-nickname-edit" checked={nicknameSupportedDraft} onCheckedChange={setNicknameSupportedDraft} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="game-zone-edit">Requires zone</Label>
              <Switch id="game-zone-edit" checked={requiresZoneDraft} onCheckedChange={setRequiresZoneDraft} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="game-server-edit">Requires server</Label>
              <Switch id="game-server-edit" checked={requiresServerDraft} onCheckedChange={setRequiresServerDraft} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="game-active-edit">Active</Label>
              <Switch id="game-active-edit" checked={isActiveDraft} onCheckedChange={setIsActiveDraft} />
            </div>
            {gameError && <p className="text-sm text-rust">{gameError}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!nameDraft.trim() || !slugDraft.trim() || savingGame}
                onClick={() => void saveGame()}
              >
                <Save className="h-4 w-4" />
                {savingGame ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditingGame(false); setGameError(null); }}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle as="h2">Provider Mappings ({game.providerMappings.length})</CardTitle>
          <Button size="sm" disabled={!canAddMapping} onClick={() => setMappingDialog({ mapping: null })}>
            <Plus className="h-4 w-4" />
            Add mapping
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            nested
            columns={[
              {
                key: "provider",
                header: "Provider",
                render: (m: ProviderMappingRow) => <span className="text-ink">{providerLabel(m.provider)}</span>,
              },
              {
                key: "code",
                header: "Code",
                render: (m: ProviderMappingRow) => <span className="font-mono text-sm text-ink-soft">{m.providerGameCode}</span>,
              },
              {
                key: "priority",
                header: "Priority",
                render: (m: ProviderMappingRow) => <span className="text-sm text-ink-soft">{m.priority}</span>,
              },
              {
                key: "enabled",
                header: "Enabled",
                render: (m: ProviderMappingRow) => (
                  <Switch
                    aria-label={`${providerLabel(m.provider)} enabled`}
                    checked={m.enabled}
                    disabled={togglingMapping.has(m.id)}
                    onCheckedChange={(checked) => void toggleMappingEnabled(m, checked)}
                  />
                ),
              },
              {
                key: "actions",
                header: "",
                render: (m: ProviderMappingRow) => (
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${providerLabel(m.provider)} mapping`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setMappingDialog({ mapping: m })}>
                          <SquarePen className="h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => { e.preventDefault(); setPendingDeleteMapping(m); }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ),
              },
            ]}
            data={game.providerMappings}
            keyExtractor={(m) => m.id}
            empty={
              <EmptyState
                title="No provider mappings"
                description="Add a mapping to let the nickname check flow query a supplier for this game."
              />
            }
          />
        </CardContent>
      </Card>

      {mappingDialog && (
        <MappingDialog
          gameId={gameId ?? ""}
          mapping={mappingDialog.mapping}
          existingProviders={mappedProviders}
          onClose={() => setMappingDialog(null)}
          onSaved={() => void invalidate()}
        />
      )}

      {pendingDeleteMapping && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDeleteMapping(null); }}
          title="Delete this mapping?"
          description={`Delete the ${providerLabel(pendingDeleteMapping.provider)} mapping for "${game.name}".`}
          confirmLabel="Delete"
          onConfirm={() => deleteMapping(pendingDeleteMapping)}
        />
      )}

      {pendingDeleteGame && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDeleteGame(false); }}
          title="Delete this game?"
          description={`Delete "${game.name}". This is refused while it's still linked to any products.`}
          confirmLabel="Delete"
          onConfirm={() => deleteGame()}
        />
      )}

      {blockedDelete && (
        <Dialog open onOpenChange={(open) => { if (!open) setBlockedDelete(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Can't delete "{game.name}" yet</DialogTitle>
              <DialogDescription>{blockedDelete}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBlockedDelete(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageLayout>
  );
}
