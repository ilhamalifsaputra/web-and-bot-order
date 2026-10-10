/** CSS cannot override an explicit smooth scroll requested by JavaScript. */
export function preferredScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
