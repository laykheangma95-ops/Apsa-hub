import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, LogOut, ShieldCheck, Store, UserRound, Users } from "lucide-react";
import {
  ActionRow,
  AppHeader,
  BottomNav,
  BottomSheet,
  ScreenBleed,
  Section,
  SectionRow,
  SectionRows,
  SegmentedControl,
  SkeletonBlock,
  Spinner,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { Button } from "@/components/ui/button";
import { EditBusinessProfileSheet } from "@/components/settings/EditBusinessProfileSheet";
import { getOrganizationProfileFn } from "@/api/org";
import { getAccountProfileFn, signOutFn } from "@/api/auth";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useLanguage } from "@/lib/i18n";
import { notifyError, notifySuccess } from "@/lib/feedback";
import {
  isBusinessProfileRowVisible,
  ORGANIZATION_PROFILE_QUERY_KEY,
  resolveBusinessSectionView,
} from "@/lib/settings-view";
import { clearHomeQueries } from "@/lib/home-query";
import { clearCustomerQueries } from "@/lib/customers-query";
import { clearDeliveryQueries } from "@/lib/deliveries-query";
import { clearConversationQueries } from "@/lib/inbox-query";
import { clearOrderQueries } from "@/lib/orders-query";
import { clearTeamQueries } from "@/lib/team-query";
import { clearCatalogQueries } from "@/lib/catalog";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [
      { title: "Settings — APSA" },
      {
        name: "description",
        content: "Your business, account and language settings, in one place.",
      },
      { property: "og:title", content: "Settings — APSA" },
      {
        property: "og:description",
        content: "Business, account, language and sign-out — all in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsScreen,
});

/**
 * Settings hub — "Business Profile" row.
 *
 * The hub row itself carries no business data beyond the display name (a
 * secondary value merchants recognize their shop by). Full details (slug,
 * currency, country) and the edit form live one tap away in a sheet — this is
 * the same read (organization.read) and write (organization.update) surface
 * the old inline block used, just relocated per the hub rule that detail
 * belongs on a detail screen, never the hub itself.
 */
function BusinessProfileRow() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const [detailOpen, setDetailOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // The profile read requires organization.read server-side. Without it the
  // row simply does not exist for this member — never a row that leads to a
  // "you don't have access" dead end.
  const canRead = capabilities.can("organization.read");
  // "Edit" is a courtesy hide, not the authorization boundary — the server
  // re-checks organization.update on every save regardless (see
  // src/server/org/update-organization-profile.ts).
  const canEdit = capabilities.can("organization.update");

  const query = useQuery({
    queryKey: ORGANIZATION_PROFILE_QUERY_KEY,
    queryFn: () => getOrganizationProfileFn(),
    retry: false,
    enabled: canRead,
  });

  const view = resolveBusinessSectionView(query);

  if (!isBusinessProfileRowVisible(canRead, view)) return null;

  const secondary = view.kind === "ready" ? view.profile.displayName : undefined;

  return (
    <>
      <ActionRow
        icon={Store}
        label={t("settings.business.rowLabel")}
        description={secondary}
        descriptionClassName="truncate"
        disabled={view.kind === "loading"}
        onClick={() => setDetailOpen(true)}
      />

      <BottomSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={t("settings.business.rowLabel")}
      >
        {view.kind === "loading" ? (
          <div className="space-y-2 py-1">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-4 w-1/2" />
            <SkeletonBlock className="h-4 w-1/3" />
          </div>
        ) : null}

        {view.kind === "error" ? (
          <OperationalState
            title={t("settings.business.errorTitle")}
            body={t("settings.business.errorBody")}
            tone="danger"
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {view.kind === "ready" ? (
          <div className="space-y-4 pb-2">
            <SectionRows>
              <SectionRow label={t("settings.business.name")} value={view.profile.displayName} />
              <SectionRow label={t("settings.business.slug")} value={view.profile.slug} />
              {view.profile.businessType ? (
                <SectionRow label={t("settings.business.type")} value={view.profile.businessType} />
              ) : null}
              <SectionRow
                label={t("settings.business.currency")}
                value={view.profile.defaultCurrency}
              />
              <SectionRow label={t("settings.business.country")} value={view.profile.country} />
            </SectionRows>

            {canEdit ? (
              <Button
                type="button"
                variant="outline"
                className="tap-target h-12 w-full"
                onClick={() => {
                  setDetailOpen(false);
                  setEditOpen(true);
                }}
              >
                {t("settings.business.edit")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </BottomSheet>

      {canEdit && view.kind === "ready" ? (
        <EditBusinessProfileSheet
          open={editOpen}
          onOpenChange={setEditOpen}
          profile={view.profile}
          onSaved={(updated) => {
            // Written directly into the cache, not just invalidated — no
            // stale business name is visible while a refetch is in flight.
            queryClient.setQueryData(ORGANIZATION_PROFILE_QUERY_KEY, updated);
            notifySuccess(t("settings.business.editForm.success"));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Settings hub — "Account & Profile" row.
 *
 * View-only: there is no account-edit capability in this codebase today, so
 * the detail sheet shows exactly what the old inline block showed (email,
 * display name) and nothing more. No edit affordance is invented here.
 */
function AccountProfileRow() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["settings", "account-profile"],
    queryFn: () => getAccountProfileFn(),
    retry: false,
  });

  const account = query.data;
  const secondary = account?.email;

  return (
    <>
      <ActionRow
        icon={UserRound}
        label={t("settings.account.rowLabel")}
        description={secondary}
        descriptionClassName="truncate"
        disabled={query.isLoading}
        onClick={() => setOpen(true)}
      />

      <BottomSheet open={open} onOpenChange={setOpen} title={t("settings.account.rowLabel")}>
        {query.isLoading ? (
          <div className="space-y-2 py-1">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-4 w-1/2" />
          </div>
        ) : null}

        {!query.isLoading && (query.isError || !account) ? (
          <OperationalState
            title={t("settings.account.errorTitle")}
            body={t("settings.account.errorBody")}
            tone="danger"
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {!query.isLoading && account ? (
          <SectionRows>
            <SectionRow label={t("settings.account.email")} value={account.email} />
            {account.displayName ? (
              <SectionRow label={t("settings.account.name")} value={account.displayName} />
            ) : null}
          </SectionRows>
        ) : null}
      </BottomSheet>
    </>
  );
}

/**
 * Settings hub — "Language" row. Same persistence and i18n wiring as before
 * (useLanguage), just presented as a compact row instead of a full-width
 * control dominating the hub.
 */
function LanguageRow() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const [open, setOpen] = useState(false);
  const secondary = language === "km" ? "ខ្មែរ" : "English";

  return (
    <>
      <ActionRow
        icon={Globe}
        label={t("settings.app.language")}
        description={secondary}
        onClick={() => setOpen(true)}
      />

      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={t("settings.app.language")}
        snap="peek"
      >
        <div className="space-y-3 pb-2">
          <SegmentedControl
            label={t("settings.app.language")}
            value={language}
            onChange={(next) => {
              setLanguage(next);
              setOpen(false);
            }}
            segments={[
              { value: "km", label: "ខ្មែរ" },
              { value: "en", label: "English" },
            ]}
          />
          <p className="text-caption text-text-muted">{t("settings.app.languageHint")}</p>
        </div>
      </BottomSheet>
    </>
  );
}

function TeamRow() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();

  // team.read is what listTeamFn requires. No read, no entry point.
  if (!capabilities.can("team.read")) return null;

  return (
    <ActionRow
      icon={Users}
      label={t("settings.team.label")}
      onClick={() => void navigate({ to: "/app/team" })}
    />
  );
}

function SecurityRow({ onOpenSecurity }: { onOpenSecurity: () => void }) {
  const { t } = useTranslation();

  return (
    <ActionRow icon={ShieldCheck} label={t("settings.section.security")} onClick={onOpenSecurity} />
  );
}

function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [securityOpen, setSecurityOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutFn();
      setSignOutOpen(false);
      await navigate({ to: "/sign-in" });
    } catch {
      notifyError(t("settings.security.signOutError"));
    } finally {
      // Always drop every cached query — even if signOutFn() failed in
      // transit, the server may have already revoked the session and
      // cleared cookies, and protected data must not survive into the next
      // session (another organization, another user) sharing this tab.
      // Runs after navigate() above so Settings has already unmounted and
      // this can't trigger a visible unauthenticated refetch/error flash
      // on this screen first.
      //
      // The tenant caches are purged through their own central helpers first:
      // none of those calls can throw, so the most sensitive data is gone even
      // if the blanket clear below fails partway. Customer PII, conversation
      // bodies, order money, delivery COD and tracking numbers, the staff
      // roster and the catalog each have a dedicated purge for exactly that
      // reason — the blanket clear is the
      // backstop here, never the primary isolation mechanism.
      clearHomeQueries(queryClient);
      clearCustomerQueries(queryClient);
      clearConversationQueries(queryClient);
      clearOrderQueries(queryClient);
      clearDeliveryQueries(queryClient);
      clearTeamQueries(queryClient);
      clearCatalogQueries(queryClient);
      queryClient.clear();
      setSigningOut(false);
    }
  }

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("settings.title")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] space-y-5 px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <p className="text-body-sm px-1 text-text-secondary">{t("settings.subtitle")}</p>

        <Section title={t("settings.section.business")} variant="plain" bodyClassName="space-y-2">
          <BusinessProfileRow />
          <TeamRow />
        </Section>

        <Section title={t("settings.section.personal")} variant="plain" bodyClassName="space-y-2">
          <AccountProfileRow />
          <LanguageRow />
        </Section>

        <Section
          title={t("settings.section.securityAccess")}
          variant="plain"
          bodyClassName="space-y-2"
        >
          <SecurityRow onOpenSecurity={() => setSecurityOpen(true)} />
        </Section>
      </main>

      <BottomSheet
        open={securityOpen}
        onOpenChange={setSecurityOpen}
        title={t("settings.section.security")}
      >
        <div className="pb-2">
          <Button
            type="button"
            variant="outline"
            className="tap-target h-12 w-full text-status-danger-text"
            onClick={() => {
              setSecurityOpen(false);
              setSignOutOpen(true);
            }}
          >
            <LogOut className="size-4" aria-hidden />
            {t("settings.security.signOut")}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={signOutOpen}
        onOpenChange={(open) => {
          if (!signingOut) setSignOutOpen(open);
        }}
        title={t("settings.security.signOutConfirmTitle")}
        description={t("settings.security.signOutConfirmBody")}
        footer={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="tap-target h-12 flex-1"
              disabled={signingOut}
              onClick={() => setSignOutOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="tap-target h-12 flex-1"
              disabled={signingOut}
              aria-busy={signingOut}
              onClick={() => void handleSignOut()}
            >
              {signingOut ? <Spinner /> : null}
              {signingOut
                ? t("settings.security.signingOut")
                : t("settings.security.signOutConfirmAction")}
            </Button>
          </div>
        }
      >
        {null}
      </BottomSheet>

      <BottomNav />
    </ScreenBleed>
  );
}
