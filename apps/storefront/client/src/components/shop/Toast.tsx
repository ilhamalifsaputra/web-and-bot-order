/**
 * Moved to `components/ui/Toast.tsx` in Fase 6 Task 7 (business-agnostic
 * primitive). This re-export keeps the 4 existing `components/shop/Toast`
 * importers working; new code should import from `components/ui/Toast`.
 */
export { default } from "../ui/Toast";
export type { ToastProps } from "../ui/Toast";
