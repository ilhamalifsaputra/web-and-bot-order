/**
 * TSX port of apps/storefront/views/reviews.njk. The rating field is a plain
 * `<select>` of 5..1 (checked the template — not radios), ported as-is.
 * Each pending-review card is its own form/component so its rating/comment
 * state stays independent; submitting posts and refetches (mirroring the
 * old 303-back-to-self flow). Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 rename (docs/REACT_STOREFRONT_MIGRATION.md):
 * `!w-20` → `w-20!`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import type { AccountReview, PendingReview, ReviewsData } from "../api/types";
import { t } from "../lib/i18n";
import Stars from "../components/shop/Stars";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";

interface ReviewSubmission {
  order_id: number;
  product_id: number | null;
  rating: number;
  comment: string;
}

function PendingReviewCard({
  pending,
  submitting,
  onSubmit,
}: {
  pending: PendingReview;
  submitting: boolean;
  onSubmit: (vars: ReviewSubmission) => void;
}) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ order_id: pending.order_id, product_id: pending.product_id, rating, comment });
  }

  return (
    <form onSubmit={handleSubmit} className="card card-pad">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-semibold text-sm">{pending.product_name}</div>
          <div className="text-xs text-ink-faint font-mono">{pending.code}</div>
        </div>
        <label className="text-xs text-ink-soft">
          {t("web.your_rating")}
          <select
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
            className="field w-20! inline-block ml-1"
          >
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>
                {r} ★
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        className="field mt-3"
        placeholder={t("web.review_placeholder")}
      />
      <div className="mt-3 text-right">
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
          {submitting && <Spinner />}
          {t("web.review_submit")}
        </button>
      </div>
    </form>
  );
}

function ReviewCard({ review }: { review: AccountReview }) {
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">{review.product_name}</div>
        <Stars rating={review.rating} />
      </div>
      {review.comment && <p className="text-sm text-ink-soft mt-2">{review.comment}</p>}
      <div className="text-xs text-ink-faint mt-2">{review.created_at_display}</div>
    </div>
  );
}

export default function ReviewsPage() {
  const { data, error, refetch } = useQuery({
    queryKey: ["account-reviews"],
    queryFn: () => apiGet<ReviewsData>("/api/v1/account/reviews"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/reviews"));
    }
  }, [error]);

  const submitMutation = useMutation({
    mutationFn: (vars: ReviewSubmission) => apiPost<{ ok: boolean }>("/api/v1/account/reviews", vars),
    onSuccess: () => refetch(),
  });

  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  return (
    <>
      <h1 className="page-title mb-6">{t("web.account_reviews")}</h1>

      {data.pending.length > 0 && (
        <section className="mb-8">
          <h2 className="section-title mb-3">{t("web.review_pending")}</h2>
          <div className="space-y-4">
            {data.pending.map((p) => (
              <PendingReviewCard
                key={p.order_id}
                pending={p}
                submitting={submitMutation.isPending}
                onSubmit={(vars) => submitMutation.mutate(vars)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="section-title mb-3">{t("web.account_reviews")}</h2>
        {data.reviews.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-4">
            {data.reviews.map((r, idx) => (
              <ReviewCard key={idx} review={r} />
            ))}
          </div>
        ) : (
          <div className="card card-pad text-center py-10">
            <p className="text-ink-faint">{t("web.reviews_none")}</p>
            {/* STO-016: same rationale as OrdersPage's empty state — give a
                first-time visitor a forward action instead of a dead end. */}
            <Link to="/" className="btn btn-soft mt-4">
              {t("web.continue_shopping")}
            </Link>
          </div>
        )}
      </section>
    </>
  );
}
