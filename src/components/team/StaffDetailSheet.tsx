import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet, StatusChip } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { INVITABLE_ROLES, RoleOption } from "@/components/team/RoleOption";
import {
  cancelInvite,
  changeStaffRole,
  reactivateStaff,
  removeStaff,
  resendInvite,
} from "@/lib/api";
import { classifyTeamActionError } from "@/lib/team-errors";
import type { Staff, StaffRole } from "@/types";

interface StaffDetailSheetProps {
  member: Staff | null;
  workspaceName: string;
  onOpenChange: (open: boolean) => void;
  onChanged: (member: Staff) => void;
  onRemoved: (id: string) => void;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maps a thrown server error to user-facing copy. Every mutating action in
 * this sheet (role change, remove, reactivate, resend, cancel) can fail for
 * several distinct reasons — owner protection, a Manager-authority cap
 * (CORRECTION-001), or an unrelated network/DB failure — and each must read
 * as what actually happened, not be papered over with "ownership is
 * protected" regardless of cause.
 */
function teamActionErrorMessage(t: ReturnType<typeof useTranslation>["t"], err: unknown): string {
  switch (classifyTeamActionError(err)) {
    case "owner_protected":
      return t("team.owner.protectedBody");
    case "insufficient_authority":
      return t("team.detail.insufficientAuthority");
    default:
      return t("team.detail.actionError");
  }
}

export function StaffDetailSheet({
  member,
  workspaceName,
  onOpenChange,
  onChanged,
  onRemoved,
}: StaffDetailSheetProps) {
  const { t } = useTranslation();
  const [editingRole, setEditingRole] = useState(false);
  const [role, setRole] = useState<StaffRole>("sales");
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!member) return;
    setEditingRole(false);
    setNotice(null);
    setInviteLink(null);
    setRole(member.role === "owner" ? "manager" : member.role);
  }, [member]);

  const isOwner = member?.role === "owner";
  const isPending = member?.status === "invited";
  const isSuspended = member?.status === "suspended";

  async function saveRole() {
    if (!member) return;
    setBusy(true);
    try {
      const updated = await changeStaffRole(member.id, role);
      onChanged(updated);
      setEditingRole(false);
      setNotice(t("team.detail.roleUpdated"));
    } catch (err) {
      setNotice(teamActionErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!member) return;
    setBusy(true);
    try {
      await removeStaff(member.id);
      onRemoved(member.id);
      onOpenChange(false);
    } catch (err) {
      setNotice(teamActionErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function reactivate() {
    if (!member) return;
    setBusy(true);
    try {
      const updated = await reactivateStaff(member.id);
      onChanged(updated);
      setNotice(t("team.detail.reactivated"));
    } catch (err) {
      setNotice(teamActionErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function invitationAction(kind: "resend" | "cancel") {
    if (!member) return;
    setBusy(true);
    try {
      if (kind === "resend") {
        const result = await resendInvite(member.id);
        setInviteLink(result.inviteLink ?? null);
        setNotice(t("team.pending.resent"));
      } else {
        await cancelInvite(member.id);
        onRemoved(member.id);
        onOpenChange(false);
      }
    } catch (err) {
      setNotice(teamActionErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!inviteLink) return;
    const ok = await copyToClipboard(inviteLink);
    if (ok) setNotice(t("team.pending.linkCopied"));
  }

  return (
    <BottomSheet
      open={member !== null}
      onOpenChange={onOpenChange}
      title={member?.name ?? ""}
      snap="half"
      className="lg:max-w-[480px]"
    >
      {member ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={member.status ?? "active"} size="md" />
            <span className="text-label text-text-primary">{t(`team.role.${member.role}`)}</span>
          </div>

          <dl className="space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-caption text-text-secondary">{t("team.detail.workspace")}</dt>
              <dd className="text-label min-w-0 break-words text-text-primary">{workspaceName}</dd>
            </div>
            {member.phone || member.email ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-caption text-text-secondary">{t("team.detail.contact")}</dt>
                <dd className="text-label min-w-0 break-words text-text-primary">
                  {member.email ?? member.phone}
                </dd>
              </div>
            ) : null}
          </dl>

          <p className="text-body text-text-secondary">
            {t(`team.roleDescription.${member.role}`)}
          </p>

          {isOwner ? (
            <OperationalState
              title={t("team.owner.protectedTitle")}
              body={t("team.owner.protectedBody")}
            />
          ) : null}

          {notice ? (
            <p className="text-caption text-text-secondary" role="status">
              {notice}
            </p>
          ) : null}

          {inviteLink ? (
            <Button
              variant="outline"
              className="tap-target h-12 w-full"
              onClick={() => void copyLink()}
            >
              {t("team.pending.copyLink")}
            </Button>
          ) : null}

          {!isOwner && editingRole ? (
            <div className="space-y-2" role="radiogroup" aria-label={t("team.detail.changeRole")}>
              {INVITABLE_ROLES.map((option) => (
                <RoleOption
                  key={option}
                  role={option}
                  selected={role === option}
                  onSelect={setRole}
                />
              ))}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="tap-target h-12 flex-1"
                  onClick={() => setEditingRole(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className="tap-target h-12 flex-1"
                  disabled={busy}
                  onClick={() => void saveRole()}
                >
                  {t("team.detail.saveRole")}
                </Button>
              </div>
            </div>
          ) : null}

          {!isOwner && !editingRole ? (
            <div className="space-y-2">
              {isPending ? (
                <>
                  <Button
                    variant="outline"
                    className="tap-target h-12 w-full"
                    disabled={busy}
                    onClick={() => void invitationAction("resend")}
                  >
                    {t("team.pending.resend")}
                  </Button>
                  <Button
                    variant="outline"
                    className="tap-target h-12 w-full text-status-danger-text"
                    disabled={busy}
                    onClick={() => void invitationAction("cancel")}
                  >
                    {t("team.pending.cancel")}
                  </Button>
                </>
              ) : isSuspended ? (
                <Button
                  className="tap-target h-12 w-full"
                  disabled={busy}
                  onClick={() => void reactivate()}
                >
                  {t("team.detail.reactivate")}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="tap-target h-12 w-full"
                    onClick={() => setEditingRole(true)}
                  >
                    {t("team.detail.changeRole")}
                  </Button>
                  <Button
                    variant="outline"
                    className="tap-target h-12 w-full text-status-danger-text"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {t("team.detail.removeAccess")}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </BottomSheet>
  );
}
