import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save, SquarePen } from "lucide-react";
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
  emailBrandColor: string;
  emailSupportAddress: string;
  emailOrderPaidSubject: string;
  emailOrderPaidTitle: string;
  emailOrderPaidSubtitle: string;
  emailOrderPaidMessage: string;
  emailResetPasswordSubject: string;
  emailResetPasswordTitle: string;
  emailResetPasswordSubtitle: string;
  emailResetPasswordMessage: string;
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

function ResetImageButton({
  label,
  field,
  hasValue,
  description,
  onReset,
}: {
  label: string;
  field: "favicon" | "logo" | "hero" | "banner";
  hasValue: boolean;
  description?: string;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Guarded by `open`, not just `hasValue`: a successful reset invalidates
  // the query, which flips `hasValue` false on refetch — without the `open`
  // escape hatch that would unmount this (and the dialog with it) mid-
  // animation, cutting off the success checkmark before the user sees it.
  if (!hasValue && !open) return null;
  return (
    <div className="pt-2">
      {hasValue && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Reset to default
        </Button>
      )}
      <SaveConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Reset ${label} to default?`}
        description={description ?? `This clears the current ${label.toLowerCase()}. It won't be shown until a new one is uploaded.`}
        confirmLabel="Reset"
        variant="destructive"
        successMessage={`${label} reset`}
        onConfirm={async () => {
          await apiPost("/api/branding/image/clear", { field });
          onReset();
        }}
      />
    </div>
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  async function save() {
    await apiPost("/api/branding/text", { key: fieldKey, value: draft });
    setEditing(false);
    onSaved();
  }

  async function reset() {
    await apiPost("/api/branding/text/reset", { key: fieldKey });
    onSaved();
  }

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        {!editing && (
          <div className="flex items-center gap-1">
            {value && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Reset ${label} to default`}
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setEditing(true); setDraft(value); }}
            >
              <SquarePen className="h-4 w-4" />
              Edit
            </Button>
          </div>
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
              <Save className="h-4 w-4" />
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
      <SaveConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={`Reset ${label} to default?`}
        description={`This clears the current ${label.toLowerCase()}. It won't be shown until a new value is saved.`}
        confirmLabel="Reset"
        variant="destructive"
        successMessage={`${label} reset`}
        onConfirm={reset}
      />
    </div>
  );
}

export function BrandingPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useBranding();

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["branding"] }); };
  // Patch just the one field the upload response told us about, instead of
  // refetching every branding image + text setting for a single-field change.
  const patchImage = (field: keyof BrandingData) => (url: string) => {
    qc.setQueryData<BrandingData>(["branding"], (old) => (old ? { ...old, [field]: url } : old));
  };

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
                onUploaded={patchImage("faviconUrl")}
                maxBytes={1 * 1024 * 1024}
                dimensions="512x512px"
                showSuccessCheckmark
              />
              <ResetImageButton
                label="Favicon"
                field="favicon"
                hasValue={Boolean(data.faviconUrl)}
                onReset={invalidate}
              />
              <ImageUploadField
                label="Logo"
                imageUrl={data.logoUrl}
                uploadPath="/branding/logo"
                fieldName="logo"
                accept=".png,.svg,.webp"
                onUploaded={patchImage("logoUrl")}
                maxBytes={1 * 1024 * 1024}
                dimensions="400x200px"
                showSuccessCheckmark
              />
              <ResetImageButton
                label="Logo"
                field="logo"
                hasValue={Boolean(data.logoUrl)}
                onReset={invalidate}
              />
              <ImageUploadField
                label="Hero image"
                imageUrl={data.heroUrl}
                uploadPath="/branding/hero"
                fieldName="hero"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={patchImage("heroUrl")}
                maxBytes={5 * 1024 * 1024}
                dimensions="1200x400px"
                showSuccessCheckmark
              />
              <ResetImageButton
                label="Hero image"
                field="hero"
                hasValue={Boolean(data.heroUrl)}
                onReset={invalidate}
              />
              <ImageUploadField
                label="Banner"
                imageUrl={data.bannerUrl}
                uploadPath="/branding/banner"
                fieldName="banner"
                accept=".jpg,.jpeg,.png,.webp"
                onUploaded={(url) =>
                  // The upload also clears the legacy Telegram file_id server-side
                  // (branding.ts's afterSave), so drop the stale warning locally too.
                  qc.setQueryData<BrandingData>(["branding"], (old) =>
                    old ? { ...old, bannerUrl: url, bannerIsLegacy: false } : old,
                  )
                }
                maxBytes={5 * 1024 * 1024}
                dimensions="1200x400px"
                showSuccessCheckmark
              />
              {data.bannerIsLegacy && (
                <p className="pt-2 text-xs text-amberx">
                  Banner is stored as a Telegram file_id. Upload an image file to replace it.
                </p>
              )}
              <ResetImageButton
                label="Banner"
                field="banner"
                hasValue={Boolean(data.bannerUrl || data.bannerIsLegacy)}
                description="This clears the bot's promo banner. It won't be shown above the menu until a new one is uploaded."
                onReset={invalidate}
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

          <Card>
            <CardHeader><CardTitle>Email Branding</CardTitle></CardHeader>
            <CardContent className="divide-y divide-line">
              <TextFieldRow
                label="Brand color"
                fieldKey="email_brand_color"
                value={data.emailBrandColor}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Support email address"
                fieldKey="email_support_address"
                value={data.emailSupportAddress}
                onSaved={invalidate}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>New Paid Order Email</CardTitle></CardHeader>
            <CardContent className="divide-y divide-line">
              <TextFieldRow
                label="Subject"
                fieldKey="email_order_paid_subject"
                value={data.emailOrderPaidSubject}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Title"
                fieldKey="email_order_paid_title"
                value={data.emailOrderPaidTitle}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Subtitle"
                fieldKey="email_order_paid_subtitle"
                value={data.emailOrderPaidSubtitle}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Message"
                fieldKey="email_order_paid_message"
                value={data.emailOrderPaidMessage}
                onSaved={invalidate}
                multiline
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Reset Password Email</CardTitle></CardHeader>
            <CardContent className="divide-y divide-line">
              <TextFieldRow
                label="Subject"
                fieldKey="email_reset_password_subject"
                value={data.emailResetPasswordSubject}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Title"
                fieldKey="email_reset_password_title"
                value={data.emailResetPasswordTitle}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Subtitle"
                fieldKey="email_reset_password_subtitle"
                value={data.emailResetPasswordSubtitle}
                onSaved={invalidate}
              />
              <TextFieldRow
                label="Message"
                fieldKey="email_reset_password_message"
                value={data.emailResetPasswordMessage}
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
