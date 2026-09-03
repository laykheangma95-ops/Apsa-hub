import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { INVITABLE_ROLES, RoleOption } from "@/components/team/RoleOption";
import { inviteStaff } from "@/lib/api";
import type { Staff, StaffRole } from "@/types";

interface InviteStaffSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: (member: Staff) => void;
}

function isValidContact(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return trimmed.replace(/\D/g, "").length >= 8;
}

export function InviteStaffSheet({ open, onOpenChange, onInvited }: InviteStaffSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [role, setRole] = useState<StaffRole>("sales");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const nameError = touched && !name.trim() ? t("team.invite.nameRequired") : null;
  const contactError = touched
    ? !contact.trim()
      ? t("team.invite.contactRequired")
      : !isValidContact(contact)
        ? t("team.invite.contactInvalid")
        : null
    : null;

  function reset() {
    setName("");
    setContact("");
    setRole("sales");
    setTouched(false);
  }

  async function submit() {
    setTouched(true);
    if (!name.trim() || !isValidContact(contact)) return;
    setSaving(true);
    const member = await inviteStaff({ name: name.trim(), contact: contact.trim(), role });
    setSaving(false);
    reset();
    onInvited(member);
    onOpenChange(false);
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("team.invite.title")}
      snap="full"
      className="lg:max-w-[480px]"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-name" className="text-label text-text-secondary">
            {t("team.invite.name")}
          </Label>
          <Input
            id="invite-name"
            className="h-12"
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {nameError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-contact" className="text-label text-text-secondary">
            {t("team.invite.contact")}
          </Label>
          <Input
            id="invite-contact"
            className="h-12"
            value={contact}
            placeholder={t("team.invite.contactPlaceholder")}
            aria-invalid={contactError ? true : undefined}
            onChange={(e) => setContact(e.target.value)}
          />
          {contactError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {contactError}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <p className="text-label text-text-secondary" id="invite-role-label">
            {t("team.invite.role")}
          </p>
          <div role="radiogroup" aria-labelledby="invite-role-label" className="space-y-2">
            {INVITABLE_ROLES.map((option) => (
              <RoleOption
                key={option}
                role={option}
                selected={role === option}
                onSelect={setRole}
              />
            ))}
          </div>
          <p className="text-caption text-text-secondary">{t("team.invite.ownerNotOffered")}</p>
        </div>

        <Button className="tap-target h-12 w-full" disabled={saving} onClick={() => void submit()}>
          {saving ? t("team.invite.sending") : t("team.invite.send")}
        </Button>
      </div>
    </BottomSheet>
  );
}
