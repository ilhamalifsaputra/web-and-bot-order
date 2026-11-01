import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ERROR_ALERT_CLASS } from "../../lib/errorAlert";
import type { BulkFailureLine } from "../../lib/bulkOutcome";

/** Why items in a bulk action did not go through. A toast fades before an admin
 * can read 20 reasons, so they stay here until closed or the view changes. */
export function BulkFailuresNotice({ failures, onDismiss }: {
  failures: readonly BulkFailureLine[];
  onDismiss: () => void;
}) {
  if (failures.length === 0) return null;
  return (
    <Alert variant="destructive" className={`mb-3 pr-10 ${ERROR_ALERT_CLASS}`}>
      <AlertTitle>Not completed</AlertTitle>
      <AlertDescription>
        <ul className="max-h-48 w-full overflow-y-auto">
          {failures.map((failure) => (
            <li key={`${failure.label}: ${failure.reason}`} className="py-0.5 break-words">
              <span className="font-mono font-semibold">{failure.label}</span>
              {" — "}
              <span>{failure.reason}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss these failures"
        className="absolute top-1 right-1"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </Alert>
  );
}
