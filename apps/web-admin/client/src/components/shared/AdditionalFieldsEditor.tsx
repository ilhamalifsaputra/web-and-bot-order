import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { emptyFieldDraft } from "../../lib/additionalFields";
import type { AdditionalFieldDraft } from "../../api/types";

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
  value,
  onChange,
}: {
  value: AdditionalFieldDraft[];
  onChange: (next: AdditionalFieldDraft[]) => void;
}) {
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
        <div key={index} className="rounded-lg border border-line p-3 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-ink">Key</label>
              <Input
                className="mt-1"
                placeholder="e.g. game_id"
                value={row.key}
                onChange={(e) => updateRow(index, { key: e.target.value })}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => removeRow(index)}>
              Remove
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-ink">Label (Indonesian)</label>
              <Input
                className="mt-1"
                placeholder="e.g. ID Game"
                value={row.labelId}
                onChange={(e) => updateRow(index, { labelId: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-ink">Label (English)</label>
              <Input
                className="mt-1"
                placeholder="e.g. Game ID"
                value={row.labelEn}
                onChange={(e) => updateRow(index, { labelEn: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-end gap-3">
            <div>
              <label className="text-xs font-medium text-ink">Type</label>
              <Select
                value={row.type}
                onValueChange={(v) => updateRow(index, { type: v as AdditionalFieldDraft["type"] })}
              >
                <SelectTrigger className="mt-1">
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
              <label className="text-xs font-medium text-ink">Options</label>
              <Input
                className="mt-1"
                placeholder="Comma-separated, e.g. Asia, EU, NA"
                value={row.optionsText}
                onChange={(e) => updateRow(index, { optionsText: e.target.value })}
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-ink">Placeholder</label>
            <Input
              className="mt-1"
              placeholder="Optional"
              value={row.placeholder}
              onChange={(e) => updateRow(index, { placeholder: e.target.value })}
            />
          </div>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={addRow} className="self-start">
        + Add Field
      </Button>
    </div>
  );
}
