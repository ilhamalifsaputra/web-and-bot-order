import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";

interface Ticket {
  id: number;
  subject: string;
  status: string;
  createdAt: string;
  user?: { fullName: string | null; username: string | null };
}

function useTickets() {
  return useQuery<{ tickets: Ticket[] }>({
    queryKey: ["support"],
    queryFn: async () => {
      const res = await fetch("/api/support");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ tickets: Ticket[] }>;
    },
  });
}

export function SupportPage() {
  const navigate = useNavigate();
  const { data, isError } = useTickets();

  if (isError) return <PageLayout title="Support"><p className="text-sm text-rust">Failed to load tickets.</p></PageLayout>;

  return (
    <PageLayout title="Support">
      <PageHeader title="Support" />

      <DataTable
        columns={[
          {
            key: "id",
            header: "#",
            render: t => <span className="font-mono text-sm">{t.id}</span>,
          },
          {
            key: "subject",
            header: "Subject",
            render: t => t.subject,
          },
          {
            key: "customer",
            header: "Customer",
            render: t => t.user?.fullName ?? t.user?.username ?? "—",
          },
          {
            key: "status",
            header: "Status",
            render: t => <StatusBadge status={t.status} />,
          },
          {
            key: "date",
            header: "Date",
            render: t => (
              <span className="text-xs text-ink-soft">
                {new Date(t.createdAt).toLocaleDateString()}
              </span>
            ),
          },
        ]}
        data={data?.tickets ?? []}
        isLoading={!data}
        keyExtractor={t => t.id}
        onRowClick={t => navigate(`/support/${t.id}`)}
        empty={<EmptyState title="No open tickets" description="All support tickets will appear here." />}
      />
    </PageLayout>
  );
}
