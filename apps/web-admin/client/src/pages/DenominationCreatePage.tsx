import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import type { AdditionalFieldDraft } from "../api/types";
import { DeliveryTypeSection } from "../components/shared/DeliveryTypeSection";
import { AUTO_DELIVERY_FIELDS_TEMPLATE } from "../components/shared/DeliveryTypeSection.helpers";
import { DenominationIdentityFields } from "../components/shared/DenominationIdentityFields";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { draftsToFields, fieldsAreValid } from "../lib/additionalFields";

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
  const fieldId = useId();
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
  // `null` until the admin touches the control, so the default can follow the
  // parent product's family once it loads. Game Top Up must not default to
  // "auto" (that draws from local stock rows, which a game top-up never holds);
  // it defaults to buyer-info delivery with the Game ID field pre-filled, which
  // is the shape a supplier-linked or hand-delivered top-up needs. Premium Apps
  // and legacy categories keep "auto".
  const [deliveryTypeChoice, setDeliveryTypeChoice] = useState<string | null>(null);
  const [additionalFieldsChoice, setAdditionalFieldsChoice] = useState<AdditionalFieldDraft[] | null>(null);
  const deliveryType = deliveryTypeChoice ?? (isGame ? "manual_with_info" : "auto");
  const additionalFields =
    additionalFieldsChoice ??
    (deliveryTypeChoice === null && isGame ? AUTO_DELIVERY_FIELDS_TEMPLATE : []);
  const setDeliveryType = (next: string) => setDeliveryTypeChoice(next);
  const setAdditionalFields = (next: AdditionalFieldDraft[]) => setAdditionalFieldsChoice(next);
  const [autoDeliverySource, setAutoDeliverySource] = useState<string | null>(null);
  const [supplierSku, setSupplierSku] = useState("");
  const [nicknameCheckGameCode, setNicknameCheckGameCode] = useState("");
  const [providerInputMapping, setProviderInputMapping] = useState("");
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
          ...(deliveryType === "manual_with_info" || (deliveryType === "auto" && additionalFields.length > 0)
            ? { additionalFields: draftsToFields(additionalFields) }
            : {}),
          ...(deliveryType === "manual_with_info" && autoDeliverySource
            ? { autoDeliverySource, supplierSku: supplierSku.trim() }
            : {}),
          ...(isGame && nicknameCheckGameCode.trim() ? { nicknameCheckGameCode: nicknameCheckGameCode.trim() } : {}),
          ...(isGame && providerInputMapping.trim() ? { providerInputMapping: providerInputMapping.trim() } : {}),
          ...(isGame && qtyValue.trim() ? { qtyValue: Number(qtyValue.trim()) } : {}),
          ...(isGame && qtyUnit.trim() ? { qtyUnit: qtyUnit.trim() } : {}),
        },
      ),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      navigate(`/catalog/${productId}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const { canSubmit } = denominationSubmission({ name, type, durationLabel, price, deliveryType, additionalFields, autoDeliverySource, supplierSku });

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
        <DenominationIdentityFields fieldId={fieldId} isGame={isGame} productName={loadedName} name={name} setName={setName} durationLabel={durationLabel} setDurationLabel={setDurationLabel} qtyValue={qtyValue} setQtyValue={setQtyValue} qtyUnit={qtyUnit} setQtyUnit={setQtyUnit} type={type} setType={setType} />

        <DeliveryTypeSection
          isGame={isGame}
          deliveryType={deliveryType}
          onDeliveryTypeChange={setDeliveryType}
          additionalFields={additionalFields}
          onAdditionalFieldsChange={setAdditionalFields}
          autoDeliverySource={autoDeliverySource}
          onAutoDeliverySourceChange={setAutoDeliverySource}
          supplierSku={supplierSku}
          onSupplierSkuChange={setSupplierSku}
          nicknameCheckGameCode={nicknameCheckGameCode}
          providerInputMapping={providerInputMapping}
          onProviderInputMappingChange={setProviderInputMapping}
          onNicknameCheckGameCodeChange={setNicknameCheckGameCode}
        />

        <div>
          <label htmlFor={`${fieldId}-price-idr-6`} className="text-sm font-medium text-ink">
            Price (IDR) <span className="text-rust">*</span>
          </label>
          <Input id={`${fieldId}-price-idr-6`}
            className="mt-1"
            placeholder="e.g. 15000"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Shown to customers.</p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-cost-price-idr-7`} className="text-sm font-medium text-ink">Cost Price (IDR)</label>
          <Input id={`${fieldId}-cost-price-idr-7`}
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
          <label htmlFor={`${fieldId}-reseller-price-idr-8`} className="text-sm font-medium text-ink">Reseller Price (IDR)</label>
          <Input id={`${fieldId}-reseller-price-idr-8`}
            className="mt-1"
            placeholder="Optional"
            value={resellerPrice}
            onChange={(e) => setResellerPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Charged instead of Price to reseller-role customers.</p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-warranty-days-9`} className="block text-sm font-medium text-ink">Warranty Days</label>
          <Input id={`${fieldId}-warranty-days-9`}
            className="mt-1 w-32"
            placeholder="Optional"
            value={warrantyDays}
            onChange={(e) => setWarrantyDays(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`${fieldId}-description-10`} className="text-sm font-medium text-ink">Description</label>
          <Textarea id={`${fieldId}-description-10`}
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

function denominationSubmission({ name, type, durationLabel, price, deliveryType, additionalFields, autoDeliverySource, supplierSku }: {
  name: string;
  type: string | null;
  durationLabel: string;
  price: string;
  deliveryType: string;
  additionalFields: AdditionalFieldDraft[];
  autoDeliverySource: string | null;
  supplierSku: string;
}) {
  const canSubmit =
    name.trim().length > 0 &&
    type !== null &&
    durationLabel.trim().length > 0 &&
    isValidPrice(price) &&
    ((deliveryType !== "manual_with_info" && additionalFields.length === 0) || fieldsAreValid(additionalFields)) &&
    (autoDeliverySource !== "digiflazz" || supplierSku.trim().length > 0);
  return { canSubmit };
}
