/**
 * TSX port of apps/storefront/views/reviews.njk. The rating field is a plain
 * `<select>` of 5..1 (checked the template — not radios).
 * Each pending-review card is its own form/component so its rating/comment
 * state stays independent; submitting posts and refetches (mirroring the
 * old 303-back-to-self flow).
 *
 * Task 16 (design-system migration): each card is a `<Card>`, the rating
 * `<select>` is `<FormField>` + `ui/Select` (kept as a native select, per the
 * brief — a 5..1 numeric picker is not a star-input case), the comment box is
 * `ui/Textarea`, the submit control is `<Button type="submit">`. The rating
 * select keeps a width cap (`w-24!`) so it doesn't stretch to `.field`'s full
 * width. Rating/comment payload is unchanged.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Star } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import type { AccountReview, PendingReview, ReviewsData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { humanError } from "../lib/errors";
import { useSuggestedProducts } from "../lib/useSuggestedProducts";
import Stars from "../components/shop/Stars";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";
import EmptyState from "../components/shop/EmptyState";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";

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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-semibold text-sm">{pending.product_name}</div>
          <div className="text-xs text-ink-faint font-mono">{pending.code}</div>
        </div>
        <FormField label={t("web.your_rating")} className="shrink-0">
          <Select
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
            className="w-24!"
          >
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>
                {r} ★
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <Textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        className="mt-3"
        placeholder={t("web.review_placeholder")}
      />
      <div className="mt-3 text-right">
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting && <Spinner />}
          {t("web.review_submit")}
        </Button>
      </div>
    </form>
  );
}

function ReviewCard({ review }: { review: AccountReview }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">{review.product_name}</div>
        <Stars rating={review.rating} />
      </div>
      {review.comment && (
        <p className="text-sm text-ink-soft mt-2 whitespace-pre-line break-words">{review.comment}</p>
      )}
      <div className="text-xs text-ink-faint mt-2">{review.created_at_display}</div>
    </Card>
  );
}

export default function ReviewsPage() {
  const { data: ctx } = useShopContext();
  const { data, error, refetch } = useQuery({
    queryKey: ["account-reviews"],
    queryFn: () => apiGet<ReviewsData>("/api/v1/account/reviews"),
    retry: false,
  });
  // Fetched only once it's known there are no reviews yet — never delays the
  // empty-state card itself, which paints from `data` alone.
  const { data: suggested } = useSuggestedProducts(!!data && data.reviews.length === 0);

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/reviews"));
    }
  }, [error]);

  const submitMutation = useMutation({
    mutationFn: (vars: ReviewSubmission) => apiPost<{ ok: boolean }>("/api/v1/account/reviews", vars),
    onSuccess: () => refetch(),
    // A refused review (already reviewed, product not on the order, …) must be
    // shown — a refetch alone would leave the card sitting there as if unsent.
    onError: () => refetch(),
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

      {/* Page-level, not inside the pending list: a refused review's card can
          vanish on the refetch (e.g. already reviewed), taking a nested banner with it. */}
      {submitMutation.isError && (
        <Alert variant="banner" tone="error">
          {humanError(submitMutation.error)}
        </Alert>
      )}

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
        {data.reviews.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-4 items-start">
            {data.reviews.map((r, idx) => (
              <ReviewCard key={idx} review={r} />
            ))}
          </div>
        ) : (
          /* STO-016 / E1: was a hand-rolled div; now the shared EmptyState so
             this matches every other "nothing here yet" screen in the shop. */
          <EmptyState
            icon={Star}
            title={t("web.reviews_none")}
            action={{ label: t("web.continue_shopping"), to: "/" }}
            suggestions={suggested ? { products: suggested.products, fx: ctx?.fx, lowThreshold: suggested.low_threshold } : undefined}
          />
        )}
      </section>
    </>
  );
}
