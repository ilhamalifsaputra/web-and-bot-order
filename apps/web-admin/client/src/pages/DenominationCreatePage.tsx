import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DeliveryTypeSection } from "../components/shared/DeliveryTypeSection";
import { ButtonLabelInput } from "../components/shared/ButtonLabelInput";
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
  product: {
    id: number;
    name: string;
    /** Decides which Telegram button the denomination text lands on (Game Top Up vs Premium Apps). */
    category?: { group: string | null } | null;
  };
}

/** Reads the same `["catalog", productId]` query the breadcrumb name has
 * always used (see the doc comment above) — no extra request. */
function useParentProduct(productId: string | undefined) {
  const { data } = useQuery<ProductForBreadcrumb>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductForBreadcrumb>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
  return {
    // Fallback while loading (or if the fetch hasn't resolved yet): the
    // product id, not a hardcoded generic "Product" label.
    name: data?.product.name ?? `Product #${productId ?? "?"}`,
    /** The real name once loaded (the fallback above is not a name the bot would ever strip). */
    loadedName: data?.product.name,
    isGame: data?.product.category?.group === "GAME_TOPUP",
  };
}

export function DenominationCreatePage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { name: productName, loadedName, isGame } = useParentProduct(productId);
  const [name, setName] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [durationLabel, setDurationLabel] = useState("");
  const [price, setPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [resellerPrice, setResellerPrice] = useState("");
  const [warrantyDays, setWarrantyDays] = useState("");
  const [description, setDescription] = useState("");
  // Compact-button quantity (Task 8/14), e.g. 86 "Diamonds" — independent of
  // every other field on this form.
  const [qtyValue, setQtyValue] = useState("");
  const [qtyUnit, setQtyUnit] = useState("");
  const [deliveryType, setDeliveryType] = useState("auto");
  const [additionalFields, setAdditionalFields] = useState<AdditionalFieldDraft[]>([]);
  const [autoDeliverySource, setAutoDeliverySource] = useState<string | null>(null);
  const [supplierSku, setSupplierSku] = useState("");
  const [nicknameCheckGameCode, setNicknameCheckGameCode] = useState("");
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
          ...(deliveryType === "manual_with_info" && autoDeliverySource
            ? { autoDeliverySource, supplierSku: supplierSku.trim() }
            : {}),
          ...(nicknameCheckGameCode.trim() ? { nicknameCheckGameCode: nicknameCheckGameCode.trim() } : {}),
          ...(qtyValue.trim() ? { qtyValue: Number(qtyValue.trim()) } : {}),
          ...(qtyUnit.trim() ? { qtyUnit: qtyUnit.trim() } : {}),
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
    (deliveryType !== "manual_with_info" || fieldsAreValid(additionalFields)) &&
    (autoDeliverySource !== "digiflazz" || supplierSku.trim().length > 0);

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
          {isGame ? (
            <ButtonLabelInput
              kind="denominationGame"
              productName={loadedName}
              builtFromQuantity={qtyValue.trim() !== "" && qtyUnit.trim() !== ""}
              className="mt-1"
              placeholder="e.g. Netflix Premium"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : (
            <Input
              className="mt-1"
              placeholder="e.g. Netflix Premium"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Duration Label <span className="text-rust">*</span>
          </label>
          {isGame ? (
            <>
              <Input
                className="mt-1"
                placeholder="e.g. 1 Month"
                value={durationLabel}
                onChange={(e) => setDurationLabel(e.target.value)}
              />
              <p data-testid="duration-label-game-hint" className="mt-1 text-xs text-ink-soft">
              Game Top Up: this reaches the Telegram button only when it differs from the Name, and is then added after the quantity. Keep it short.
            </p>
            </>
          ) : (
            <ButtonLabelInput
              kind="denominationPlan"
              className="mt-1"
              placeholder="e.g. 1 Month"
              value={durationLabel}
              onChange={(e) => setDurationLabel(e.target.value)}
            />
          )}
        </div>

        {/* Compact-button quantity (Task 8/14) — optional, powers the bot's
            "86 Diamonds"-style compact denomination button label. */}
        <div className="flex gap-3">
          <div>
            <label className="block text-sm font-medium text-ink">Quantity Value</label>
            <Input
              className="mt-1 w-32"
              type="number"
              min="0"
              step="1"
              placeholder="e.g. 86"
              value={qtyValue}
              onChange={(e) => setQtyValue(e.target.value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <label className="block text-sm font-medium text-ink">Quantity Unit</label>
            {isGame ? (
              <ButtonLabelInput
                kind="qtyUnit"
                className="mt-1"
                placeholder="e.g. Diamonds"
                value={qtyUnit}
                onChange={(e) => setQtyUnit(e.target.value)}
              />
            ) : (
              <Input
                className="mt-1"
                placeholder="e.g. Diamonds"
                value={qtyUnit}
                onChange={(e) => setQtyUnit(e.target.value)}
              />
            )}
          </div>
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
          autoDeliverySource={autoDeliverySource}
          onAutoDeliverySourceChange={setAutoDeliverySource}
          supplierSku={supplierSku}
          onSupplierSkuChange={setSupplierSku}
          nicknameCheckGameCode={nicknameCheckGameCode}
          onNicknameCheckGameCodeChange={setNicknameCheckGameCode}
        />

        <div>
          <label className="text-sm font-medium text-ink">
            Price (IDR) <span className="text-rust">*</span>
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
          <label className="text-sm font-medium text-ink">Cost Price (IDR)</label>
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
          <label className="text-sm font-medium text-ink">Reseller Price (IDR)</label>
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
