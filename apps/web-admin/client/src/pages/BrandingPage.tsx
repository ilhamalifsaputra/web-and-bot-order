import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ImageUploadField } from "../components/shared/ImageUploadField";
import { SaveConfirmDialog } from "../components/shared/SaveConfirmDialog";
import { apiPost } from "../api/client";

interface BrandingData {
  faviconUrl: string;
  logoUrl: string;
  heroUrl: string;
  bannerUrl: string;
  bannerIsLegacy: boolean;
  shopName: string;
  shopTagline: string;
  welcome: string;
}

function useBranding() {
  return useQuery<BrandingData>({
    queryKey: ["branding"],
    queryFn: async () => {
      const res = await fetch("/api/branding");
      if (!res.ok) throw new Error(`Failed to load branding (${res.status})`);
      return res.json() as Promise<BrandingData>;
    },
  });
}

function TextFieldRow({
  label,
  fieldKey,
  value,
  onSaved,
  multiline,
}: {
  label: string;
  fieldKey: string;
  value: string;
  onSaved: () => void;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function save() {
    await apiPost("/api/branding/text", { key: fieldKey, value: draft });
    setEditing(false);
    onSaved();
  }

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setEditing(true); setDraft(value); }}
          >
            Edit
          </Button>
        )}
      </div>
      {!editing && (
        <div className="mt-1 text-sm text-ink-soft">
          {value || <em className="text-ink-soft">not set</em>}
        </div>
      )}
      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          {multiline ? (
            <Textarea
              rows={4}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              autoFocus
            />
          ) : (
            <Input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              autoFocus
              className="max-w-sm"
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setConfirmOpen(true)}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {/* Rendered unconditionally (not inside `editing && …`) — save()
          flips `editing` false as soon as the request resolves, which would
          otherwise unmount this mid-animation and cut off the checkmark. */}
      <SaveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Save "${label}"?`}
        description="This updates the live setting immediately."
        onConfirm={save}
      />
    </div>
  );
}

export function BrandingPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useBranding();
  const [removeBannerOpen, setRemoveBannerOpen] = useState(false);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["branding"] }); };

  return (
    <PageLayout title="Branding">
      <PageHeader title="Branding" />

      {isLoading && <p className="text-sm text-ink-soft">Loading branding…</p>}
      {isError && <p className="text-sm text-rust">Failed to load branding.</p>}

      {data && (
        <div className="flex flex-col gap-6 max-w-2xl">
          <Card>
            <CardHeader><CardTitle>Images</CardTitle></CardHeader>
            <CardContent className="divide-y divide-line">
              <ImageUploadField
                label="Favicon"
                imageUrl={data.faviconUrl}
                uploadPath="/branding/favicon"
                fieldName="favicon"
                accept=".png,.ico,.svg"
                onUploaded={invalidate}
                dimensions="512x512px"
                showSuccessCheckmark
              />
              <ImageUploadField
                label="Logo"
                imageUrl={data.logoUrl}
                uploadPath="/branding/logo"
                fieldName="logo"
                accept=".png,.svg,.webp"
                onUploaded={invalidate}
                dimensions="400x200px"
                showSuccessCheckmark
              />
              <ImageUploadField
                label="Hero image"
                imageUrl={data.heroUrl}
                uploadPath="/branding/hero"
                fieldName="hero"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={invalidate}
                dimensions="1200x400px"
                showSuccessCheckmark
              />
              <ImageUploadField
                label="Banner"
                imageUrl={data.bannerUrl}
                uploadPath="/branding/banner"
                fieldName="banner"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={invalidate}
                dimensions="1200x400px"
                showSuccessCheckmark
              />
              {data.bannerIsLegacy && (
                <p className="pt-2 text-xs text-amberx">
                  Banner is stored as a Telegram file_id. Upload an image file to replace it.
                </p>
              )}
              {(data.bannerUrl || data.bannerIsLegacy) && (
                <div className="pt-2">
                  <Button variant="ghost" size="sm" onClick={() => setRemoveBannerOpen(true)}>
                    Remove banner
                  </Button>
                </div>
              )}
              {/* Rendered unconditionally — removing the banner clears
                  data.bannerUrl on refetch, which would otherwise unmount
                  this mid-animation and cut off the checkmark. */}
              <SaveConfirmDialog
                open={removeBannerOpen}
                onOpenChange={setRemoveBannerOpen}
                title="Remove banner?"
                description="This clears the bot's promo banner. It won't be shown above the menu until a new one is uploaded."
                confirmLabel="Remove"
                variant="destructive"
                successMessage="Banner removed"
                onConfirm={async () => {
                  await apiPost("/branding/banner/clear", {});
                  invalidate();
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Text</CardTitle></CardHeader>
            <CardContent className="divide-y divide-line">
              <TextFieldRow
                label="Shop name"
                fieldKey="shop_name"
                value={data.shopName}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Shop tagline"
                fieldKey="shop_tagline"
                value={data.shopTagline}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Welcome message"
                fieldKey="welcome"
                value={data.welcome}
                onSaved={invalidate}
                multiline
              />
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
