import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
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
    <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        {!editing && (
          <button
            onClick={() => {
              setEditing(true);
              setDraft(value);
            }}
            style={{ padding: "3px 8px", fontSize: 12 }}
          >
            Edit
          </button>
        )}
      </div>
      {!editing && (
        <div style={{ fontSize: 13, color: "#555", marginTop: 2 }}>
          {value || <em style={{ color: "#aaa" }}>not set</em>}
        </div>
      )}
      {editing && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          {multiline ? (
            <textarea
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ padding: "6px 8px", resize: "vertical" }}
              autoFocus
            />
          ) : (
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ padding: "6px 8px" }}
              autoFocus
            />
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={save} disabled={saving} style={{ padding: "4px 10px" }}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              style={{ padding: "4px 10px" }}
            >
              Cancel
            </button>
          </div>
          {error && <p style={{ color: "red", margin: 0, fontSize: 12 }}>{error}</p>}
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
}: {
  label: string;
  imageUrl: string;
  uploadPath: string;
  fieldName: string;
  accept: string;
  onUploaded: () => void;
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
    <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>{label}</div>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={label}
          style={{
            maxHeight: 80,
            maxWidth: 200,
            display: "block",
            marginBottom: 6,
            border: "1px solid #ddd",
          }}
        />
      ) : (
        <p style={{ fontSize: 13, color: "#aaa", margin: "0 0 6px" }}>No image set</p>
      )}
      <label style={{ fontSize: 13, cursor: "pointer" }}>
        <input
          type="file"
          accept={accept}
          onChange={handleFile}
          style={{ display: "none" }}
        />
        <span
          style={{
            padding: "4px 10px",
            background: "#f0f0f0",
            border: "1px solid #ccc",
            borderRadius: 4,
          }}
        >
          {uploading ? "Uploading…" : "Choose file…"}
        </span>
      </label>
      {uploadError && (
        <p style={{ color: "red", fontSize: 12, margin: "4px 0 0" }}>{uploadError}</p>
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
      {isLoading && <p>Loading branding…</p>}
      {isError && <p style={{ color: "red" }}>Failed to load branding.</p>}

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 600 }}>
          {/* Images */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Images</h2>
            <ImageUploadRow
              label="Favicon"
              imageUrl={data.faviconUrl}
              uploadPath="/branding/favicon"
              fieldName="favicon"
              accept=".png,.ico,.svg"
              onUploaded={invalidate}
            />
            <ImageUploadRow
              label="Logo"
              imageUrl={data.logoUrl}
              uploadPath="/branding/logo"
              fieldName="logo"
              accept=".png,.svg,.webp"
              onUploaded={invalidate}
            />
            <ImageUploadRow
              label="Hero image"
              imageUrl={data.heroUrl}
              uploadPath="/branding/hero"
              fieldName="hero"
              accept=".jpg,.jpeg,.png,.webp"
              onUploaded={invalidate}
            />
            <ImageUploadRow
              label="Banner"
              imageUrl={data.bannerUrl}
              uploadPath="/branding/banner"
              fieldName="banner"
              accept=".jpg,.jpeg,.png,.webp"
              onUploaded={invalidate}
            />
            {data.bannerIsLegacy && (
              <p style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>
                Banner is stored as a Telegram file_id. Upload an image file to replace it.
              </p>
            )}
          </section>

          {/* Text fields */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Text</h2>
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
          </section>
        </div>
      )}
    </PageLayout>
  );
}
