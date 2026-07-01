import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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

function csrfToken(): string {
  return (
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? ""
  );
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

function ImageUploadRow({
  label,
  imageUrl,
  uploadPath,
  fieldName,
  accept,
  onUploaded,
  dimensions,
}: {
  label: string;
  imageUrl: string;
  uploadPath: string;
  fieldName: string;
  accept: string;
  onUploaded: () => void;
  dimensions?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append(fieldName, file);
    try {
      const res = await fetch(uploadPath, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken() },
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      onUploaded();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="text-sm font-medium text-ink mb-1">{label}</div>
      {dimensions && (
        <p className="text-xs text-ink-soft mb-2">Recommended: {dimensions}</p>
      )}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={label}
          className="max-h-20 max-w-[200px] block mb-2 border border-line rounded"
        />
      ) : (
        <p className="text-xs text-ink-soft mb-2">No image set</p>
      )}
      <label className="cursor-pointer">
        <input
          type="file"
          accept={accept}
          onChange={handleFile}
          className="hidden"
        />
        <span className="inline-flex items-center rounded border border-line bg-card px-3 py-1 text-sm text-ink hover:bg-sand">
          {uploading ? "Uploading…" : "Choose file…"}
        </span>
      </label>
      {uploadError && (
        <p className="mt-1 text-xs text-rust">{uploadError}</p>
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
              <ImageUploadRow
                label="Favicon"
                imageUrl={data.faviconUrl}
                uploadPath="/branding/favicon"
                fieldName="favicon"
                accept=".png,.ico,.svg"
                onUploaded={invalidate}
                dimensions="512x512px"
              />
              <ImageUploadRow
                label="Logo"
                imageUrl={data.logoUrl}
                uploadPath="/branding/logo"
                fieldName="logo"
                accept=".png,.svg,.webp"
                onUploaded={invalidate}
                dimensions="400x200px"
              />
              <ImageUploadRow
                label="Hero image"
                imageUrl={data.heroUrl}
                uploadPath="/branding/hero"
                fieldName="hero"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={invalidate}
                dimensions="1200x400px"
              />
              <ImageUploadRow
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
