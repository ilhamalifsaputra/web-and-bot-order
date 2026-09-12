import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { GameDialog } from "../components/catalog/GameDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Gamepad2, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { useGames, GAMES_QUERY_KEY, type GameRow } from "../api/games";
import { describeError } from "../lib/errorMessages";

export function GamesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGames();

  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<Set<number>>(new Set());

  const games = data?.games ?? [];

  const invalidateGames = () => queryClient.invalidateQueries({ queryKey: GAMES_QUERY_KEY });

  async function toggleActive(id: number, isActive: boolean) {
    setToggling((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/games/${id}/edit`, { isActive });
      await invalidateGames();
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update the game."));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  if (isError) {
    return (
      <PageLayout title="Games">
        <PageHeader title="Games" />
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load games"
          description="Something went wrong fetching the games."
          action={{ label: "Retry", onClick: () => void refetch() }}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Games">
      <PageHeader
        title="Games"
        description="Games power the multi-provider nickname check — link each one to the supplier codes it can be looked up under."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Add Game
          </Button>
        }
      />

      <Card>
        <CardContent>
          <DataTable
            nested
            columns={[
              {
                key: "name",
                header: "Name",
                render: (row: GameRow) => <span className="text-ink">{row.name}</span>,
              },
              {
                key: "slug",
                header: "Slug",
                render: (row: GameRow) => <span className="font-mono text-xs text-ink-soft">{row.slug}</span>,
              },
              {
                key: "category",
                header: "Category",
                render: (row: GameRow) => <span className="text-ink-soft">{row.category ?? "—"}</span>,
              },
              {
                key: "mappings",
                header: "Provider Mappings",
                render: (row: GameRow) => (
                  <span className="text-ink-soft">
                    {row.providerMappings.length} {row.providerMappings.length === 1 ? "provider" : "providers"}
                  </span>
                ),
              },
              {
                key: "active",
                header: "Active",
                render: (row: GameRow) => (
                  <Switch
                    aria-label={`${row.name} active`}
                    checked={row.isActive}
                    disabled={toggling.has(row.id)}
                    onCheckedChange={(checked) => void toggleActive(row.id, checked)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ),
              },
            ]}
            data={games}
            isLoading={isLoading}
            keyExtractor={(row) => row.id}
            onRowClick={(row) => navigate(`/games/${row.id}`)}
            empty={
              <EmptyState
                icon={Gamepad2}
                title="No games yet"
                description="Games link a nickname-checkable title to the supplier codes used for its lookups."
                action={{ label: "Add Game", onClick: () => setCreating(true) }}
              />
            }
          />
        </CardContent>
      </Card>

      {creating && (
        <GameDialog onClose={() => setCreating(false)} onSaved={() => void invalidateGames()} />
      )}
    </PageLayout>
  );
}
