import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DeliveryTypeSection } from "../components/shared/DeliveryTypeSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiGet, apiPost } from "../api/client";
import { draftsToFields, fieldsAreValid } from "../lib/additionalFields";
import type { AdditionalFieldDraft } from "../api/types";

const DENOMINATION_TYPES = [
  { value: "SHARED", label: "Shared" },
  { value: "PRIVATE", label: "Private" },
];

function isValidPrice(value: string): boolean {
  if (value.trim() === "") return false;
  return !Number.isNaN(Number(value.trim()));
}

/** F-007: the breadcrumb previously showed the literal word "Product"
 * instead of the actual product name. Only the name is needed here (not
 * the full detail payload `ProductDetailPage.tsx` fetches), but it's the
 * same `GET /api/catalog/:id` endpoint and `["catalog", productId]` query
 * key, so react-query shares one cache entry when both pages are visited
 * in a session — no extra request in the common "detail → new denomination"
 * navigation path. */
interface ProductForBreadcrumb {
  product: { id: number; name: string };
}

function useProductName(productId: string | undefined): string {
  const { data } = useQuery<ProductForBreadcrumb>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductForBreadcrumb>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
  // Fallback while loading (or if the fetch hasn't resolved yet): the
  // product id, not a hardcoded generic "Product" label.
  return data?.product.name ?? `Product #${productId ?? "?"}`;
}

export function DenominationCreatePage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const productName = useProductName(productId);
  const [name, setName] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [durationLabel, setDurationLabel] = useState("");
  const [price, setPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [resellerPrice, setResellerPrice] = useState("");
  const [warrantyDays, setWarrantyDays] = useState("");
  const [description, setDescription] = useState("");
  const [deliveryType, setDeliveryType] = useState("auto");
  const [additionalFields, setAdditionalFields] = useState<AdditionalFieldDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiPost<{ id: number; name: string; slug: string }>(
        `/api/catalog/products/${productId}/denominations`,
        {
          name: name.trim(),
          type,
          durationLabel: durationLabel.trim(),
          price: price.trim(),
          ...(costPrice.trim() ? { costPrice: costPrice.trim() } : {}),
          ...(resellerPrice.trim() ? { resellerPrice: resellerPrice.trim() } : {}),
          ...(warrantyDays.trim() ? { warrantyDays: Number(warrantyDays.trim()) } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          deliveryType,
          ...(deliveryType === "manual_with_info"
            ? { additionalFields: draftsToFields(additionalFields) }
            : {}),
        },
      ),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      navigate(`/catalog/${productId}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSubmit =
    name.trim().length > 0 &&
    type !== null &&
    durationLabel.trim().length > 0 &&
    isValidPrice(price) &&
    (deliveryType !== "manual_with_info" || fieldsAreValid(additionalFields));

  return (
    <PageLayout title="New Denomination">
      <PageHeader
        title="New Denomination"
        breadcrumb={[
          { label: "Catalog", href: "/catalog" },
          { label: productName, href: `/catalog/${productId}` },
        ]}
      />

      <div className="max-w-lg flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <Input
            className="mt-1"
            placeholder="e.g. Netflix Premium"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Duration Label <span className="text-rust">*</span>
          </label>
          <Input
            className="mt-1"
            placeholder="e.g. 1 Month"
            value={durationLabel}
            onChange={(e) => setDurationLabel(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Account Type <span className="text-rust">*</span>
          </label>
          <Select value={type ?? ""} onValueChange={(v) => setType(v)}>
            <SelectTrigger className="mt-1" aria-label="Account Type">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-ink-soft">
            Shared = one account used by multiple buyers at once. Private = a dedicated account for a
            single buyer.
          </p>
        </div>

        <DeliveryTypeSection
          deliveryType={deliveryType}
          onDeliveryTypeChange={setDeliveryType}
          additionalFields={additionalFields}
          onAdditionalFieldsChange={setAdditionalFields}
        />

        <div>
          <label className="text-sm font-medium text-ink">
            Price <span className="text-rust">*</span>
          </label>
          <Input
            className="mt-1"
            placeholder="e.g. 15000"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Shown to customers.</p>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Cost Price</label>
          <Input
            className="mt-1"
            placeholder="Optional"
            value={costPrice}
            onChange={(e) => setCostPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">
            What you pay your supplier. For margin reports only — buyers never see this.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Reseller Price</label>
          <Input
            className="mt-1"
            placeholder="Optional"
            value={resellerPrice}
            onChange={(e) => setResellerPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Charged instead of Price to reseller-role customers.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink">Warranty Days</label>
          <Input
            className="mt-1 w-32"
            placeholder="Optional"
            value={warrantyDays}
            onChange={(e) => setWarrantyDays(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Description</label>
          <Textarea
            className="mt-1"
            rows={3}
            placeholder="Optional"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button disabled={!canSubmit || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create Denomination"}
        </Button>
      </div>
    </PageLayout>
  );
}
