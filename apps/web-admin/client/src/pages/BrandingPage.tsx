import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ImageUploadField } from "../components/shared/ImageUploadField";
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/branding/text", { key: fieldKey, value: draft });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
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
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setEditing(false); setError(null); }}
            >
              Cancel
            </Button>
          </div>
          {error && <p className="text-xs text-rust">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function BrandingPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useBranding();

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
              />
              <ImageUploadField
                label="Logo"
                imageUrl={data.logoUrl}
                uploadPath="/branding/logo"
                fieldName="logo"
                accept=".png,.svg,.webp"
                onUploaded={invalidate}
                dimensions="400x200px"
              />
              <ImageUploadField
                label="Hero image"
                imageUrl={data.heroUrl}
                uploadPath="/branding/hero"
                fieldName="hero"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={invalidate}
                dimensions="1200x400px"
              />
              <ImageUploadField
                label="Banner"
                imageUrl={data.bannerUrl}
                uploadPath="/branding/banner"
                fieldName="banner"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={invalidate}
                dimensions="1200x400px"
              />
              {data.bannerIsLegacy && (
                <p className="pt-2 text-xs text-amberx">
                  Banner is stored as a Telegram file_id. Upload an image file to replace it.
                </p>
              )}
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
