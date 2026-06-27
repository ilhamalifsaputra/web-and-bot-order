import { useState } from "react";
import { publicPost } from "../api/client";

interface ShopPostResult {
  ok: boolean;
  redirect: string;
}

export function SetupShopPage() {
  const [shopName, setShopName] = useState("");
  const [shopTagline, setShopTagline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(skip: boolean) {
    setError(null);
    setLoading(true);
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
      setLoading(false);
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
            <label htmlFor="shop_name" className="mb-1 block text-sm font-medium text-ink">
              Shop name <span className="text-ink-soft text-xs">(optional)</span>
            </label>
            <input
              id="shop_name"
              type="text"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="My Shop"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={loading}
            />
          </div>

          <div>
            <label htmlFor="shop_tagline" className="mb-1 block text-sm font-medium text-ink">
              Tagline <span className="text-ink-soft text-xs">(optional)</span>
            </label>
            <input
              id="shop_tagline"
              type="text"
              value={shopTagline}
              onChange={(e) => setShopTagline(e.target.value)}
              placeholder="The best shop around"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={loading}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void handleSubmit(false)}
            disabled={loading}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {loading ? "Saving…" : "Save & finish"}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit(true)}
            disabled={loading}
            className="w-full rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper disabled:opacity-40"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
