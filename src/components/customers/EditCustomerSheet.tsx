import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, Spinner } from "@/design-system";
import { updateRealCustomer, type OrderCustomerOption } from "@/lib/api";
import {
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_PHONE_MAX_LENGTH,
  classifyCustomerError,
  planCustomerEdit,
  type CustomerErrorKind,
} from "@/lib/customers-view";

interface EditCustomerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  /** The current values as the SERVER returned them — never a local guess. */
  currentName: string;
  /** "" when there is none on file OR it is withheld from this member. */
  currentPhone: string;
  /**
   * The member's current, confirmed ability to see this customer's phone:
   * `canSensitive("customers.view_sensitive")` AND the server's own
   * `sensitiveVisible` for this payload. False means the phone is not offered
   * for editing at all — updateCustomer() would refuse it anyway.
   */
  canEditPhone: boolean;
  onSaved: (updated: OrderCustomerOption) => void;
  /** Runs after every attempt, success or failure, so the profile is re-read from the server. */
  onSettled: () => void;
}

/**
 * Customer 360 → Edit.
 *
 * Name for any member holding `customers.update_basic`; phone only for one who
 * can also see it. Only changed fields are sent. A save is reported as saved
 * only after the server answered with the updated record — there is no
 * optimistic update, because a customer's name and phone are what staff read
 * aloud to identify a caller, and a value shown before the server accepted it
 * could be one it rejected.
 *
 * Removing a phone number asks once before it is sent: it is the one change
 * here that cannot be undone from what is on screen.
 */
export function EditCustomerSheet({
  open,
  onOpenChange,
  customerId,
  currentName,
  currentPhone,
  canEditPhone,
  onSaved,
  onSettled,
}: EditCustomerSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(currentName);
  const [phone, setPhone] = useState(currentPhone);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorKind, setErrorKind] = useState<CustomerErrorKind | null>(null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setPhone(currentPhone);
      setConfirmingRemoval(false);
      setSaving(false);
      setErrorKind(null);
    }
  }, [open, currentName, currentPhone]);

  const plan = planCustomerEdit({
    current: { name: currentName, phone: currentPhone },
    draft: { name, phone },
    canEditPhone,
  });

  async function handleSave() {
    // Guards against a double-tap firing two overlapping saves.
    if (saving || !plan.canSubmit) return;
    if (plan.removesPhone && !confirmingRemoval) {
      setConfirmingRemoval(true);
      return;
    }

    setSaving(true);
    setErrorKind(null);
    try {
      const updated = await updateRealCustomer(customerId, plan.patch);
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      setErrorKind(classifyCustomerError(err));
      setConfirmingRemoval(false);
    } finally {
      setSaving(false);
      onSettled();
    }
  }

  const nameError =
    plan.errors.name === "name_required"
      ? t("customerEdit.nameRequired")
      : plan.errors.name === "name_too_long"
        ? t("customerEdit.nameTooLong", { max: CUSTOMER_NAME_MAX_LENGTH })
        : null;
  const phoneError =
    plan.errors.phone === "phone_too_long"
      ? t("customerEdit.phoneTooLong", { max: CUSTOMER_PHONE_MAX_LENGTH })
      : null;

  const errorCopy: Record<CustomerErrorKind, string> = {
    unauthorized: t("customerEdit.error.unauthorized"),
    forbidden: t("customerEdit.error.forbidden"),
    not_found: t("customerEdit.error.notFound"),
    invalid: t("customerEdit.error.invalid"),
    error: t("customerEdit.error.generic"),
  };

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={t("customerEdit.title")}
      description={t("customerEdit.description")}
      snap="full"
      className="lg:max-w-[520px]"
      footer={
        <Button
          type="button"
          className="tap-target h-12 w-full"
          variant={confirmingRemoval ? "destructive" : "default"}
          disabled={saving || !plan.canSubmit}
          aria-busy={saving}
          onClick={() => void handleSave()}
        >
          {saving ? <Spinner /> : null}
          {saving
            ? t("customerEdit.saving")
            : confirmingRemoval
              ? t("customerEdit.confirmRemovePhone")
              : t("customerEdit.save")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer-edit-name" className="text-label text-text-secondary">
            {t("customerEdit.name")}
          </Label>
          <Input
            id="customer-edit-name"
            className="h-12"
            autoComplete="off"
            value={name}
            maxLength={CUSTOMER_NAME_MAX_LENGTH}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "customer-edit-name-error" : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? (
            <p
              id="customer-edit-name-error"
              className="text-caption text-status-danger-text"
              role="alert"
            >
              {nameError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer-edit-phone" className="text-label text-text-secondary">
            {t("customerEdit.phone")}
          </Label>
          {canEditPhone ? (
            <>
              <Input
                id="customer-edit-phone"
                className="tnum h-12"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={phone}
                maxLength={CUSTOMER_PHONE_MAX_LENGTH}
                aria-invalid={phoneError ? true : undefined}
                aria-describedby={
                  phoneError ? "customer-edit-phone-error" : "customer-edit-phone-hint"
                }
                onChange={(event) => {
                  setPhone(event.target.value);
                  setConfirmingRemoval(false);
                }}
              />
              {phoneError ? (
                <p
                  id="customer-edit-phone-error"
                  className="text-caption text-status-danger-text"
                  role="alert"
                >
                  {phoneError}
                </p>
              ) : (
                <p id="customer-edit-phone-hint" className="text-caption text-text-secondary">
                  {t("customerEdit.phoneHint")}
                </p>
              )}
            </>
          ) : (
            <p
              id="customer-edit-phone"
              className="text-body-sm rounded-xl bg-surface-secondary px-3 py-2 text-text-secondary"
            >
              {t("customerEdit.phoneHidden")}
            </p>
          )}
        </div>

        {confirmingRemoval ? (
          <p className="text-caption text-status-warning-text" role="status">
            {t("customerEdit.removePhoneWarning")}
          </p>
        ) : null}

        {errorKind ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {errorCopy[errorKind]}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
