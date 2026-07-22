/**
 * base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself).
 *
 * One definition, lifted out of the fourteen byte-identical copies that had
 * accumulated across the pages — a shared indicator has to look the same
 * everywhere, and fourteen copies is fourteen chances for it not to.
 */
export default function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin"
    />
  );
}
