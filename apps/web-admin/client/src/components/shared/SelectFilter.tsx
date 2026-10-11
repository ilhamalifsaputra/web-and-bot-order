import type { ReactNode } from "react";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../ui/select";
interface Props {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName: string;
  placeholder?: string;
  "aria-label"?: string;
  size?: "sm" | "default";
  children: ReactNode;
}
export function SelectFilter({ id, label, value, onValueChange, triggerClassName, placeholder, children, ...triggerProps }: Props) {
  return <div className="flex flex-col gap-1">
    <label htmlFor={id} className="text-xs text-ink-soft">{label}</label>
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className={triggerClassName} {...triggerProps}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  </div>;
}
