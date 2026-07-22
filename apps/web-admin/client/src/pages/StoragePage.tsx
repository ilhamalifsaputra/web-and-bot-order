import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HardDrive, Image, Package, Megaphone, MessageCircle, Database } from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { StatCard } from "../components/shared/StatCard";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface FolderStat {
  name: "branding" | "products" | "broadcasts" | "tickets";
  fileCount: number;
  totalBytes: number;
}

interface StorageSummary {
  folders: FolderStat[];
  dbBytes: number;
}

interface CleanupSummary {
  broadcastFilesDeleted: number;
  ticketFilesDeleted: number;
  outboxRowsDeleted: number;
  resetTokensDeleted: number;
  cartsDeleted: number;
}

const FOLDER_META: Record<FolderStat["name"], { label: string; icon: typeof Image }> = {
  branding: { label: "Branding", icon: Image },
  products: { label: "Products", icon: Package },
  broadcasts: { label: "Broadcasts", icon: Megaphone },
  tickets: { label: "Ticket Evidence", icon: MessageCircle },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function StoragePage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<StorageSummary>({
    queryKey: ["storage-summary"],
    queryFn: () => apiGet<StorageSummary>("/api/storage/summary"),
  });

  const cleanupMutation = useMutation({
    mutationFn: () => apiPost<{ summary: CleanupSummary }>("/api/storage/cleanup", {}),
    onSuccess: ({ summary }) => {
      void queryClient.invalidateQueries({ queryKey: ["storage-summary"] });
      toast.success(
        `Cleanup finished — removed ${summary.broadcastFilesDeleted} broadcast image(s), ` +
          `${summary.ticketFilesDeleted} ticket attachment(s); pruned ${summary.outboxRowsDeleted} outbox row(s), ` +
          `${summary.resetTokensDeleted} reset token(s), and ${summary.cartsDeleted} abandoned cart line(s).`,
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  return (
    <PageLayout title="Storage">
      <PageHeader
        title="Storage"
        description="Disk usage for uploaded files and the shop database."
      />

      <div className="flex flex-col gap-6">
        {isError && <p className="text-sm text-rust">Failed to load storage usage.</p>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data?.folders.map((folder) => {
            const meta = FOLDER_META[folder.name];
            return (
              <StatCard
                key={folder.name}
                label={`${meta.label} (${folder.fileCount})`}
                value={formatBytes(folder.totalBytes)}
                icon={meta.icon}
                isLoading={isLoading}
              />
            );
          })}
          <StatCard
            label="Database"
            value={data ? formatBytes(data.dbBytes) : "—"}
            icon={Database}
            isLoading={isLoading}
          />
        </div>

        <Card size="sm">
          <CardContent className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" />
              <div>
                <p className="text-sm font-semibold text-ink">Storage cleanup</p>
                <p className="text-sm text-ink-soft">
                  Removes broadcast images and ticket evidence older than 30 days, and
                  prunes old outbox, password-reset, and abandoned-cart rows. Runs
                  automatically every night — use this to run it right now instead.
                </p>
              </div>
            </div>
            <ConfirmDialog
              trigger={
                <Button variant="outline" disabled={cleanupMutation.isPending}>
                  {cleanupMutation.isPending ? "Cleaning up…" : "Run cleanup now"}
                </Button>
              }
              title="Run storage cleanup now?"
              description="This permanently deletes eligible broadcast images and ticket evidence files older than 30 days, and prunes old outbox, password-reset, and abandoned-cart rows. This cannot be undone."
              confirmLabel="Run cleanup"
              variant="destructive"
              onConfirm={async () => {
                await cleanupMutation.mutateAsync();
              }}
            />
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}
