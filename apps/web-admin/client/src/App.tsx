import { RevenueKpiCard } from "./components/dashboard/RevenueKpiCard";

export default function App() {
  return (
    <div className="min-h-screen bg-paper p-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink mb-6">Shop Admin</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <RevenueKpiCard />
      </div>
    </div>
  );
}
