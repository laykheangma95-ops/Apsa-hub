import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppHeader, BottomNav, ListSkeleton } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { StaffRow } from "@/components/team/StaffRow";
import { InviteStaffSheet } from "@/components/team/InviteStaffSheet";
import { StaffDetailSheet } from "@/components/team/StaffDetailSheet";
import { WorkspaceSwitcherSheet } from "@/components/team/WorkspaceSwitcherSheet";
import { currentRole, getTeam, getWorkspaces } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { permissionsFor } from "@/lib/permissions";
import type { Staff } from "@/types";

export const Route = createFileRoute("/app/team")({
  head: () => ({
    meta: [
      { title: "Team — APSA" },
      {
        name: "description",
        content: "See who works in your shop, invite staff and set what each person can do.",
      },
      { property: "og:title", content: "Team — APSA" },
      {
        property: "og:description",
        content: "Staff list, pending invitations and simple roles for your Cambodian shop.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TeamScreen,
});

function TeamScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const permissions = permissionsFor(currentRole);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<Staff | null>(null);
  const [extra, setExtra] = useState<Staff[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [roleChanges, setRoleChanges] = useState<Record<string, Staff>>({});

  const teamQuery = useQuery({
    queryKey: ["team"],
    queryFn: getTeam,
    enabled: permissions.manageTeam,
  });
  const workspaceQuery = useQuery({ queryKey: ["workspaces"], queryFn: getWorkspaces });

  const activeWorkspace = workspaceQuery.data?.find((w) => w.active);
  const workspaceName = activeWorkspace ? localName(activeWorkspace, language) : "";

  const members = useMemo(() => {
    const base = [...(teamQuery.data ?? []), ...extra];
    return base
      .filter((m) => !removed.includes(m.id))
      .map((m) => roleChanges[m.id] ?? m);
  }, [teamQuery.data, extra, removed, roleChanges]);

  const ownerOnly = members.length === 1 && members[0]?.role === "owner";

  return (
    <div className="min-h-dvh bg-surface-secondary pb-28">
      <AppHeader
        title={workspaceName || t("team.title")}
        subtitle={activeWorkspace ? t("team.workspace.type.business") : undefined}
        onShopSwitch={() => setSwitcherOpen(true)}
      />

      <main className="mx-auto w-full max-w-[560px] px-4 py-4 lg:max-w-[880px]">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-h2 truncate text-text-primary">{t("team.title")}</h1>
            <p className="text-caption break-words text-text-secondary">{t("team.subtitle")}</p>
          </div>
          {permissions.manageTeam ? (
            <Button className="tap-target h-12" onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-4" aria-hidden />
              <span>{t("team.inviteAction")}</span>
            </Button>
          ) : null}
        </div>

        <div className="mt-4">
          {!permissions.manageTeam ? (
            <OperationalState
              title={t("team.restricted.title")}
              body={t("team.restricted.body")}
            />
          ) : teamQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : teamQuery.isError ? (
            <OperationalState
              title={t("team.error.title")}
              body={t("team.error.body")}
              tone="danger"
              onRetry={() => void teamQuery.refetch()}
            />
          ) : (
            <>
              {ownerOnly ? (
                <OperationalState
                  title={t("team.empty.title")}
                  body={t("team.empty.body")}
                  className="mb-3"
                />
              ) : null}
              <ul className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0">
                {members.map((member) => (
                  <li key={member.id}>
                    <StaffRow member={member} onOpen={setSelected} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>

      <WorkspaceSwitcherSheet
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        onSwitched={() => void workspaceQuery.refetch()}
      />

      <InviteStaffSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(member) => setExtra((prev) => [...prev, member])}
      />

      <StaffDetailSheet
        member={selected}
        workspaceName={workspaceName}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onChanged={(member) => {
          setRoleChanges((prev) => ({ ...prev, [member.id]: member }));
          setSelected(member);
        }}
        onRemoved={(id) => {
          setRemoved((prev) => [...prev, id]);
          setSelected(null);
        }}
      />

      <BottomNav />
    </div>
  );
}
