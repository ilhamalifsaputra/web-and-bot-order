import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { useId } from "react";
import type { AdditionalFieldDraft } from "../../api/types";
import { emptyFieldDraft } from "../../lib/additionalFields";

const FIELD_TYPES: { value: AdditionalFieldDraft["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "number", label: "Number" },
  { value: "url", label: "URL" },
  { value: "select", label: "Select (dropdown)" },
];

/**
 * Dynamic editor for a manual_with_info SKU's custom checkout fields —
 * shared by DenominationCreatePage and DenominationEditPage so the ~100
 * lines of row JSX + add/remove logic isn't duplicated between them.
 * Controlled component: the parent owns `value` (a list of
 * AdditionalFieldDraft — the free-typed, still-editable shape) and passes
 * the next list back through `onChange`, same parent-owned-useState pattern
 * both pages already use for every other field.
 */
export function AdditionalFieldsEditor({
  isGame = false,
  value,
  onChange,
}: {
  isGame?: boolean;
  value: AdditionalFieldDraft[];
  onChange: (next: AdditionalFieldDraft[]) => void;
}) {
  const fieldId = useId();
  function updateRow(index: number, patch: Partial<AdditionalFieldDraft>) {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }
  function addRow() {
    onChange([...value, emptyFieldDraft()]);
  }

  return (
    <div className="flex flex-col gap-4">
      {value.map((row, index) => (
        <div key={row.draftId ?? `stored:${row.key}`} className="rounded-lg border border-line p-3 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${fieldId}-question-indonesian-1-${row.draftId ?? row.key}`} className="text-xs font-medium text-ink">Question (Indonesian)</label>
                <Input id={`${fieldId}-question-indonesian-1-${row.draftId ?? row.key}`}
                  className="mt-1"
                  placeholder={isGame ? "e.g. ID Game" : "e.g. Email akun"}
                  value={row.labelId}
                  onChange={(e) => updateRow(index, { labelId: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-question-english-2-${row.draftId ?? row.key}`} className="text-xs font-medium text-ink">Question (English)</label>
                <Input id={`${fieldId}-question-english-2-${row.draftId ?? row.key}`}
                  className="mt-1"
                  placeholder={isGame ? "e.g. Game ID" : "e.g. Account email"}
                  value={row.labelEn}
                  onChange={(e) => updateRow(index, { labelEn: e.target.value })}
                />
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => removeRow(index)}>
              Remove
            </Button>
          </div>

          <div className="flex items-end gap-3">
            <div>
              <label htmlFor={`${fieldId}-answer-type-3-${row.draftId ?? row.key}`} className="text-xs font-medium text-ink">Answer Type</label>
              <Select
                value={row.type}
                onValueChange={(v) => updateRow(index, { type: v as AdditionalFieldDraft["type"] })}
              >
                <SelectTrigger id={`${fieldId}-answer-type-3-${row.draftId ?? row.key}`} className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pb-2">
              <Checkbox
                checked={row.required}
                onCheckedChange={(checked) => updateRow(index, { required: checked === true })}
              />
              <span className="text-sm text-ink">Required</span>
            </label>
          </div>

          {row.type === "select" && (
            <div>
              <label htmlFor={`${fieldId}-options-4-${row.draftId ?? row.key}`} className="text-xs font-medium text-ink">Options</label>
              <Input id={`${fieldId}-options-4-${row.draftId ?? row.key}`}
                className="mt-1"
                placeholder="Comma-separated, e.g. Asia, EU, NA"
                value={row.optionsText}
                onChange={(e) => updateRow(index, { optionsText: e.target.value })}
              />
            </div>
          )}

          <div>
            <label htmlFor={`${fieldId}-placeholder-optional-5-${row.draftId ?? row.key}`} className="text-xs font-medium text-ink">Placeholder (Optional)</label>
            <Input id={`${fieldId}-placeholder-optional-5-${row.draftId ?? row.key}`}
              className="mt-1"
              placeholder={isGame ? "e.g. 1023849571" : "e.g. buyer@example.com"}
              value={row.placeholder}
              onChange={(e) => updateRow(index, { placeholder: e.target.value })}
            />
            <p className="mt-1 text-xs text-ink-soft">
              Optional. Shown as light grey text before the buyer types anything.
            </p>
          </div>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={addRow} className="self-start">
        <Plus className="h-4 w-4" />
        Add Field
      </Button>
    </div>
  );
}
