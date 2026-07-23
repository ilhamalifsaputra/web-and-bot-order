import { MessageCircle, Clock, UserX, CheckCircle2, CalendarCheck, AlertTriangle } from "lucide-react";
import { StatCard } from "../../components/shared/StatCard";
import { useTicketsKpis } from "../../hooks/useTicketsKpis";

export function TicketsKpiRow(): JSX.Element {
  const { data, isLoading } = useTicketsKpis();

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Open" value={data?.open ?? 0} icon={MessageCircle} isLoading={isLoading} />
      <StatCard label="Waiting Customer" value={data?.waitingCustomer ?? 0} icon={Clock} isLoading={isLoading} />
      <StatCard
        label="Unassigned"
        value={data?.unassigned ?? 0}
        icon={UserX}
        tone="warning"
        isLoading={isLoading}
      />
      <StatCard
        label="Resolved"
        value={data?.resolved ?? 0}
        icon={CheckCircle2}
        tone="success"
        isLoading={isLoading}
      />
      <StatCard label="Closed Today" value={data?.closedToday ?? 0} icon={CalendarCheck} isLoading={isLoading} />
      <StatCard
        label="Overdue"
        value={data?.overdue ?? 0}
        icon={AlertTriangle}
        tone="danger"
        isLoading={isLoading}
      />
    </div>
  );
}
