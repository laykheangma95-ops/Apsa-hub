import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, Spinner } from "@/design-system";
import type { OrganizationProfile } from "@/api/org";
import { classifyBusinessProfileSaveError, updateBusinessProfile } from "@/lib/settings-view";

interface EditBusinessProfileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: OrganizationProfile;
  onSaved: (updated: OrganizationProfile) => void;
}

const DISPLAY_NAME_MAX = 255;
const BUSINESS_TYPE_MAX = 100;

/**
 * Settings "Business" → Edit (Phase 1).
 *
 * Only display_name and business_type are editable here — legal_name, slug,
 * default_currency and country stay read-only (see
 * src/server/org/update-organization-profile.ts for why). The sheet is only
 * mounted when the caller already holds organization.update
 * (src/routes/app.settings.tsx); updateOrganizationProfile() re-checks it
 * server-side regardless, so a mid-session permission change still fails
 * safely rather than showing a fake success.
 */
export function EditBusinessProfileSheet({
  open,
  onOpenChange,
  profile,
  onSaved,
}: EditBusinessProfileSheetProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [businessType, setBusinessType] = useState(profile.businessType ?? "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorKind, setErrorKind] = useState<"denied" | "server" | null>(null);

  useEffect(() => {
    if (open) {
      setDisplayName(profile.displayName);
      setBusinessType(profile.businessType ?? "");
      setTouched(false);
      setSaving(false);
      setErrorKind(null);
    }
  }, [open, profile]);

  const trimmedName = displayName.trim();
  const nameError =
    touched && trimmedName === ""
      ? t("settings.business.editForm.nameRequired")
      : touched && trimmedName.length > DISPLAY_NAME_MAX
        ? t("settings.business.editForm.nameTooLong")
        : null;
  const typeError =
    businessType.trim().length > BUSINESS_TYPE_MAX
      ? t("settings.business.editForm.typeTooLong")
      : null;

  const canSubmit = trimmedName !== "" && trimmedName.length <= DISPLAY_NAME_MAX && !typeError;

  async function handleSave() {
    // Guards against a double-tap firing two overlapping saves.
    if (saving) return;
    setTouched(true);
    if (!canSubmit) return;

    setSaving(true);
    setErrorKind(null);
    try {
      const updated = await updateBusinessProfile({
        displayName: trimmedName,
        businessType: businessType.trim() === "" ? null : businessType.trim(),
      });
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      setErrorKind(classifyBusinessProfileSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={t("settings.business.editForm.title")}
      snap="full"
      className="lg:max-w-[520px]"
      footer={
        <Button
          type="button"
          className="tap-target h-12 w-full"
          disabled={saving || (touched && !canSubmit)}
          aria-busy={saving}
          onClick={() => void handleSave()}
        >
          {saving ? <Spinner /> : null}
          {saving ? t("settings.business.editForm.saving") : t("settings.business.editForm.save")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="business-display-name" className="text-label text-text-secondary">
            {t("settings.business.name")}
          </Label>
          <Input
            id="business-display-name"
            className="h-12"
            value={displayName}
            maxLength={DISPLAY_NAME_MAX}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setDisplayName(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          {nameError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {nameError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="business-type" className="text-label text-text-secondary">
            {t("settings.business.type")}
          </Label>
          <Input
            id="business-type"
            className="h-12"
            value={businessType}
            maxLength={BUSINESS_TYPE_MAX}
            aria-invalid={typeError ? true : undefined}
            onChange={(event) => setBusinessType(event.target.value)}
          />
          {typeError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {typeError}
            </p>
          ) : null}
        </div>

        {errorKind ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {errorKind === "denied"
              ? t("settings.business.editForm.errorDenied")
              : t("settings.business.editForm.errorServer")}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
