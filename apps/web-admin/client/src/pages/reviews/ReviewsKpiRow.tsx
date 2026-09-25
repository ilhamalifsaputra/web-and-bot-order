import { MessageSquare, Star, Clock, ThumbsDown, EyeOff } from "lucide-react";
import { StatCard } from "../../components/shared/StatCard";
import { useReviewsKpis } from "../../hooks/useReviewsKpis";

interface ReviewsKpiRowProps {
  /** Clicking "Pending Reply" sets the page's status filter — owned by the
   *  assembling page (ReviewsPage.tsx), not this component. */
  onPendingReplyClick?: () => void;
  /** Clicking "Negative Reviews" sets the page's sentiment filter. */
  onNegativeClick?: () => void;
  /** Clicking "Hidden Reviews" sets the page's hidden filter. */
  onHiddenClick?: () => void;
}

export function ReviewsKpiRow({
  onPendingReplyClick,
  onNegativeClick,
  onHiddenClick,
}: ReviewsKpiRowProps): JSX.Element {
  const { data, isError } = useReviewsKpis();

  // See OrdersKpiRow's identical comment: `!data`, not react-query's
  // `isLoading`, is what actually distinguishes "nothing loaded yet or the
  // fetch failed" from "a real (possibly zero) count arrived".
  if (isError && !data) {
    return <p className="mb-4 text-sm text-rust">Couldn't load review stats.</p>;
  }
  const isLoading = !data;

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Reviews" value={data?.totalReviews ?? 0} icon={MessageSquare} isLoading={isLoading} />
      <StatCard
        label="Average Rating"
        value={data?.avgRating != null ? data.avgRating.toFixed(1) : "—"}
        icon={Star}
        isLoading={isLoading}
      />
      <StatCard
        label="Pending Reply"
        value={data?.pendingReplyCount ?? 0}
        icon={Clock}
        tone="warning"
        isLoading={isLoading}
        onClick={onPendingReplyClick}
      />
      <StatCard
        label="Negative Reviews"
        value={data?.negativeCount ?? 0}
        icon={ThumbsDown}
        tone="danger"
        isLoading={isLoading}
        onClick={onNegativeClick}
      />
      <StatCard
        label="Hidden Reviews"
        value={data?.hiddenCount ?? 0}
        icon={EyeOff}
        isLoading={isLoading}
        onClick={onHiddenClick}
      />
    </div>
  );
}
