import { useState } from "react";
import { publicPost } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ShopPostResult {
  ok: boolean;
  redirect: string;
}

export function SetupShopPage() {
  const [shopName, setShopName] = useState("");
  const [shopTagline, setShopTagline] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which button is in flight, so only that one shows the spinner.
  const [pendingAction, setPendingAction] = useState<"save" | "skip" | null>(null);
  const loading = pendingAction !== null;

  async function handleSubmit(skip: boolean) {
    setError(null);
    setPendingAction(skip ? "skip" : "save");
    try {
      const body = skip ? { skip: "1" } : { shop_name: shopName, shop_tagline: shopTagline };
      const result = await publicPost<ShopPostResult>("/setup/shop", body);
      if (result.ok) {
        // Full navigation (not React Router) so the auto-login session cookie is
        // picked up by the browser before the next page load.
        window.location.href = result.redirect;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <p className="text-sm text-ink-soft">Step 3 of 3</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">Shop details</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Give your shop a name and tagline. You can change these later in Branding settings.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="mb-6 flex flex-col gap-4">
          <div>
            <Label htmlFor="shop_name">
              Shop name <span className="text-ink-soft text-xs">(optional)</span>
            </Label>
            <Input
              id="shop_name"
              type="text"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="My Shop"
              disabled={loading}
            />
          </div>

          <div>
            <Label htmlFor="shop_tagline">
              Tagline <span className="text-ink-soft text-xs">(optional)</span>
            </Label>
            <Input
              id="shop_tagline"
              type="text"
              value={shopTagline}
              onChange={(e) => setShopTagline(e.target.value)}
              placeholder="The best shop around"
              disabled={loading}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Button pending={pendingAction === "save"}
            type="button"
            onClick={() => void handleSubmit(false)}
            disabled={loading}
            className="w-full"
          >
            {pendingAction === "save" ? "Saving…" : "Save & finish"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSubmit(true)}
            pending={pendingAction === "skip"}
            disabled={loading}
            className="w-full"
          >
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}
