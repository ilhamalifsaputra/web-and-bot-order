import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { CategoryDialog } from "../components/catalog/CategoryDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  FolderTree,
  MoreVertical,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPost } from "../api/client";
import {
  useCatalog,
  countProductsInCategory,
  CATALOG_QUERY_KEY,
  type CategoryRow,
} from "../api/catalog";
import { describeError } from "../lib/errorMessages";

/** A delete the server refused because the category still holds products. */
interface BlockedDelete {
  category: CategoryRow;
  message: string;
}

export function CategoriesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useCatalog();

  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CategoryRow | null>(null);
  const [blocked, setBlocked] = useState<BlockedDelete | null>(null);
  const [toggling, setToggling] = useState<Set<number>>(new Set());
  const [reordering, setReordering] = useState(false);

  const categories = data?.categories ?? [];
  const products = data?.products ?? [];

  const invalidateCatalog = () => queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });

  async function toggleActive(id: number, isActive: boolean) {
    setToggling((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/categories/${id}/active`, { active: isActive });
      await invalidateCatalog();
    } catch (e) {
      toast.error(describeError(e, "Failed to update the category."));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  /** Swap one category with its neighbour and persist the whole visible order. */
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= categories.length) return;
    const ids = categories.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setReordering(true);
    try {
      await apiPost("/api/catalog/categories/reorder", { ids });
      await invalidateCatalog();
    } catch (e) {
      toast.error(describeError(e, "Failed to reorder categories."));
    } finally {
      setReordering(false);
    }
  }

  async function remove(category: CategoryRow) {
    try {
      await apiDelete(`/api/catalog/categories/${category.id}`);
      await invalidateCatalog();
      toast.success(`Deleted "${category.name}".`);
    } catch (e) {
      // The server refuses a category that still holds products, and answers
      // with a sentence naming the count. Show that instead of a generic
      // failure, and point at the products rather than inviting a retry that
      // would fail exactly the same way.
      setBlocked({
        category,
        message: e instanceof Error ? e.message : "Failed to delete the category.",
      });
    }
  }

  function viewProducts(categoryId: number) {
    navigate(`/catalog?categoryId=${categoryId}`);
  }

  if (isError) {
    return (
      <PageLayout title="Categories">
        <PageHeader title="Categories" />
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load categories"
          description="Something went wrong fetching the catalog."
          action={{ label: "Retry", onClick: () => void refetch() }}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Categories">
      <PageHeader
        title="Categories"
        description="Group products into the shelves customers browse. Order here is the order they appear in the shop."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New category
          </Button>
        }
      />

      <Card>
        <CardContent>
        <DataTable
          nested
          columns={[
            {
              key: "order",
              header: "Order",
              className: "w-24",
              render: (row: CategoryRow) => {
                const index = categories.findIndex((c) => c.id === row.id);
                return (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Move ${row.name} up`}
                      disabled={reordering || index <= 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Move ${row.name} down`}
                      disabled={reordering || index >= categories.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </div>
                );
              },
            },
            {
              key: "name",
              header: "Name",
              render: (row: CategoryRow) => (
                <div className="min-w-0">
                  <div className="truncate text-ink">
                    {row.emoji ? `${row.emoji} ` : ""}
                    {row.name}
                  </div>
                  <div className="truncate font-mono text-xs text-ink-soft">/c/{row.slug}</div>
                </div>
              ),
            },
            {
              key: "description",
              header: "Description",
              render: (row: CategoryRow) => (
                <span className="line-clamp-2 text-ink-soft">{row.description || "—"}</span>
              ),
            },
            {
              key: "products",
              header: "Products",
              render: (row: CategoryRow) => {
                const count = countProductsInCategory(products, row.id);
                return (
                  <Button
                    variant="link"
                    size="sm"
                    className="px-0"
                    onClick={() => viewProducts(row.id)}
                  >
                    {count} {count === 1 ? "product" : "products"}
                  </Button>
                );
              },
            },
            {
              key: "active",
              header: "Active",
              render: (row: CategoryRow) => (
                <Switch
                  aria-label={`${row.name} active`}
                  checked={row.isActive}
                  disabled={toggling.has(row.id)}
                  onCheckedChange={(checked) => void toggleActive(row.id, checked)}
                />
              ),
            },
            {
              key: "actions",
              header: "",
              render: (row: CategoryRow) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${row.name}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(row)}>
                        <SquarePen className="h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={(e) => {
                          e.preventDefault();
                          setPendingDelete(row);
                        }}
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
        data={categories}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        empty={
          <EmptyState
            icon={FolderTree}
            title="No categories yet"
            description="Categories are the shelves your shop is organised into — every product belongs to one."
            action={{ label: "New category", onClick: () => setCreating(true) }}
          />
        }
        />
        </CardContent>
      </Card>

      {creating && (
        <CategoryDialog
          onClose={() => setCreating(false)}
          onSaved={() => void invalidateCatalog()}
        />
      )}

      {editing && (
        <CategoryDialog
          category={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void invalidateCatalog()}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          title="Delete this category?"
          description={`Delete "${pendingDelete.name}". This is refused while it still has products.`}
          confirmLabel="Delete"
          onConfirm={() => remove(pendingDelete)}
        />
      )}

      {blocked && (
        <Dialog open onOpenChange={(open) => { if (!open) setBlocked(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Can't delete "{blocked.category.name}" yet</DialogTitle>
              <DialogDescription>{blocked.message}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBlocked(null)}>Close</Button>
              <Button
                onClick={() => {
                  const id = blocked.category.id;
                  setBlocked(null);
                  viewProducts(id);
                }}
              >
                View its products
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageLayout>
  );
}
