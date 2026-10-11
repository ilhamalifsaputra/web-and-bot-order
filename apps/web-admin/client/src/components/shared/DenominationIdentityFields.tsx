import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ButtonLabelInput } from "./ButtonLabelInput";
const DENOMINATION_TYPES = [{ value: "SHARED", label: "Shared" }, { value: "PRIVATE", label: "Private" }];

interface Props {
  fieldId: string;
  isGame: boolean;
  productName: string | undefined;
  name: string;
  setName: (value: string) => void;
  durationLabel: string;
  setDurationLabel: (value: string) => void;
  qtyValue: string;
  setQtyValue: (value: string) => void;
  qtyUnit: string;
  setQtyUnit: (value: string) => void;
  type: string | null;
  setType: (value: string) => void;
}

export function DenominationIdentityFields({ fieldId, isGame, productName, name, setName, durationLabel, setDurationLabel, qtyValue, setQtyValue, qtyUnit, setQtyUnit, type, setType }: Props) {
  return <>
    <div>
      <label htmlFor={`${fieldId}-name-1`} className="text-sm font-medium text-ink">
        Name <span className="text-rust">*</span>
      </label>
      {isGame ? (
        <ButtonLabelInput id={`${fieldId}-name-1`}
          kind="denominationGame"
          productName={productName}
          builtFromQuantity={qtyValue.trim() !== "" && qtyUnit.trim() !== ""}
          className="mt-1"
          placeholder="e.g. Netflix Premium"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      ) : (
        <Input id={`${fieldId}-name-1`}
          className="mt-1"
          placeholder="e.g. Netflix Premium"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
    </div>

    <div>
      <label htmlFor={`${fieldId}-duration-label-2`} className="text-sm font-medium text-ink">
        Duration Label <span className="text-rust">*</span>
      </label>
      {isGame ? (
        <>
          <Input id={`${fieldId}-duration-label-2`}
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
        <ButtonLabelInput id={`${fieldId}-duration-label-2`}
          kind="denominationPlan"
          className="mt-1"
          placeholder="e.g. 1 Month"
          value={durationLabel}
          onChange={(e) => setDurationLabel(e.target.value)}
        />
      )}
    </div>

    {/* Game Top Up quantity builds the compact Telegram button label. */}
    {isGame && (
      <div className="flex gap-3">
        <div>
          <label htmlFor={`${fieldId}-quantity-value-3`} className="block text-sm font-medium text-ink">Quantity Value</label>
          <Input id={`${fieldId}-quantity-value-3`}
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
          <label htmlFor={`${fieldId}-quantity-unit-4`} className="block text-sm font-medium text-ink">Quantity Unit</label>
          <ButtonLabelInput id={`${fieldId}-quantity-unit-4`}
            kind="qtyUnit"
            className="mt-1"
            placeholder="e.g. Diamonds"
            value={qtyUnit}
            onChange={(e) => setQtyUnit(e.target.value)}
          />
        </div>
      </div>
    )}

    <div>
      <label htmlFor={`${fieldId}-account-type-5`} className="text-sm font-medium text-ink">
        Account Type <span className="text-rust">*</span>
      </label>
      <Select value={type ?? ""} onValueChange={(v) => setType(v)}>
        <SelectTrigger id={`${fieldId}-account-type-5`} className="mt-1" aria-label="Account Type">
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

  </>;
}
