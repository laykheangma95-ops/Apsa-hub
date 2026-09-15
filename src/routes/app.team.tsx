import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
import { AppHeader, BottomNav, ListSkeleton, ScreenBleed } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { StaffRow } from "@/components/team/StaffRow";
import { InviteStaffSheet } from "@/components/team/InviteStaffSheet";
import { StaffDetailSheet } from "@/components/team/StaffDetailSheet";
import { WorkspaceSwitcherSheet } from "@/components/team/WorkspaceSwitcherSheet";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getTeam, getWorkspaces } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { isPermissionDeniedError } from "@/lib/team-errors";
import { teamKeys } from "@/lib/team-query";
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
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();

  /*
   * The roster carries every staff member's name, email or phone, role and
   * membership status. It was keyed on the bare string `["team"]`, so
   * Organization A's roster was readable, unchanged, by a member of
   * Organization B who mounted this screen next in the same tab.
   *
   * Identity comes from the /app route guard's server-derived context — the
   * validated session and the active membership row — never from the
   * capability snapshot. It partitions the cache and nothing else: listTeamFn
   * re-checks team.read server-side, and every membership mutation re-checks
   * its own grant plus CORRECTION-001's role-authority cap.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const rosterKey = teamKeys.roster(session.userId, routeOrganizationId);
  // listTeamFn requires team.read; inviteStaffFn requires team.invite. Both are
  // re-checked on the server for every call — this only decides what is shown.
  const canReadTeam = capabilities.can("team.read");
  const canInvite = capabilities.can("team.invite");

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<Staff | null>(null);
  const [extra, setExtra] = useState<Staff[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [roleChanges, setRoleChanges] = useState<Record<string, Staff>>({});

  const teamQuery = useQuery({
    queryKey: rosterKey,
    queryFn: getTeam,
    enabled: canReadTeam,
  });

  /*
   * Every membership mutation makes this principal's roster stale, and nothing
   * else. The local overlays below (extra/removed/roleChanges) keep the change
   * on screen immediately; this is what reconciles them with what the server
   * actually stored — including a role the server capped under CORRECTION-001
   * differently from what the sheet optimistically showed.
   *
   * Deliberately narrow: this principal's roster root only. No other user's
   * partition, no queryClient.clear().
   */
  function invalidateRoster() {
    void queryClient.invalidateQueries({ queryKey: rosterKey });
  }
  const workspaceQuery = useQuery({ queryKey: ["workspaces"], queryFn: getWorkspaces });

  const activeWorkspace = workspaceQuery.data?.find((w) => w.active);
  const workspaceName = activeWorkspace ? localName(activeWorkspace, language) : "";

  const members = useMemo(() => {
    const base = [...(teamQuery.data ?? []), ...extra];
    return base.filter((m) => !removed.includes(m.id)).map((m) => roleChanges[m.id] ?? m);
  }, [teamQuery.data, extra, removed, roleChanges]);

  const ownerOnly = members.length === 1 && members[0]?.role === "owner";

  return (
    <ScreenBleed bottom="nav" surface="raised">
      {/*
       * The header already names the workspace, so the screen does not repeat
       * it; the one action it owns sits in the pinned bar within thumb reach
       * instead of on a row of its own.
       */}
      <AppHeader
        title={t("team.title")}
        subtitle={workspaceName || undefined}
        onShopSwitch={() => setSwitcherOpen(true)}
        {...(canInvite
          ? {
              action: (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  aria-label={t("team.inviteAction")}
                  className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary text-text-on-action"
                >
                  <UserPlus className="size-5" aria-hidden />
                </button>
              ),
            }
          : {})}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <p className="text-body-sm px-1 text-text-secondary">{t("team.subtitle")}</p>

        <div className="mt-3">
          {!canReadTeam ? (
            <CapabilityDeniedState capabilities={capabilities} />
          ) : teamQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : teamQuery.isError ? (
            isPermissionDeniedError(teamQuery.error) ? (
              <OperationalState
                title={t("team.restricted.title")}
                body={t("team.restricted.body")}
              />
            ) : (
              <OperationalState
                title={t("team.error.title")}
                body={t("team.error.body")}
                tone="danger"
                onRetry={() => void teamQuery.refetch()}
              />
            )
          ) : (
            <>
              {ownerOnly ? (
                <OperationalState
                  title={t("team.empty.title")}
                  body={t("team.empty.body")}
                  className="mb-3"
                />
              ) : null}
              <ul className="list-enter space-y-2 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0">
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
        onInvited={(member) => {
          setExtra((prev) => [...prev, member]);
          invalidateRoster();
        }}
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
          invalidateRoster();
        }}
        onRemoved={(id) => {
          setRemoved((prev) => [...prev, id]);
          setSelected(null);
          invalidateRoster();
        }}
      />

      <BottomNav />
    </ScreenBleed>
  );
}
