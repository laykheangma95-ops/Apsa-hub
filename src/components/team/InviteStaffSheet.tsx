import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { INVITABLE_ROLES, RoleOption } from "@/components/team/RoleOption";
import { inviteStaff, type InviteStaffResult } from "@/lib/api";
import { classifyInviteError } from "@/lib/team-errors";
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

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function InviteStaffSheet({ open, onOpenChange, onInvited }: InviteStaffSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [role, setRole] = useState<StaffRole>("sales");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [invited, setInvited] = useState<InviteStaffResult | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

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
    setFormError(null);
    setInvited(null);
    setLinkCopied(false);
  }

  async function submit() {
    setTouched(true);
    if (!name.trim() || !isValidContact(contact)) return;
    setSaving(true);
    setFormError(null);
    try {
      const member = await inviteStaff({ name: name.trim(), contact: contact.trim(), role });
      if (member.inviteLink) {
        // No email/SMS delivery exists yet — hold the sheet open so the owner
        // can copy the link before it disappears (UX_FLOWS.md §53).
        setInvited(member);
        onInvited(member);
      } else {
        onInvited(member);
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      switch (classifyInviteError(err)) {
        case "duplicate":
          setFormError(t("team.invite.duplicate"));
          break;
        case "insufficient_authority":
          setFormError(t("team.invite.insufficientAuthority"));
          break;
        default:
          setFormError(t("team.invite.error"));
      }
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    if (!invited?.inviteLink) return;
    const ok = await copyToClipboard(invited.inviteLink);
    setLinkCopied(ok);
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
      {invited ? (
        <div className="space-y-4">
          <p className="text-body text-text-secondary">{t("team.invite.linkHint")}</p>
          <div className="rounded-2xl border border-border-default bg-surface-secondary p-3">
            <p className="text-caption text-text-secondary">{t("team.invite.linkTitle")}</p>
            <p className="text-label mt-1 break-all text-text-primary">{invited.inviteLink}</p>
          </div>
          {linkCopied ? (
            <p className="text-caption text-text-secondary" role="status">
              {t("team.invite.linkCopied")}
            </p>
          ) : null}
          <Button
            variant="outline"
            className="tap-target h-12 w-full"
            onClick={() => void copyLink()}
          >
            {t("team.invite.copyLink")}
          </Button>
          <Button
            className="tap-target h-12 w-full"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("team.invite.done")}
          </Button>
        </div>
      ) : (
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

          {formError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {formError}
            </p>
          ) : null}

          <Button
            className="tap-target h-12 w-full"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? t("team.invite.sending") : t("team.invite.send")}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
