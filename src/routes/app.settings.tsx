import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, Users } from "lucide-react";
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
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { Button } from "@/components/ui/button";
import { getOrganizationProfileFn } from "@/api/org";
import { getAccountProfileFn, signOutFn } from "@/api/auth";
import { currentRole } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { notifyError } from "@/lib/feedback";
import { permissionsFor } from "@/lib/permissions";
import { isPermissionDeniedError } from "@/lib/team-errors";

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

function BusinessSection() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["settings", "organization-profile"],
    queryFn: () => getOrganizationProfileFn(),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <Section title={t("settings.section.business")}>
        <div className="space-y-2 py-1">
          <SkeletonBlock className="h-4 w-2/3" />
          <SkeletonBlock className="h-4 w-1/2" />
          <SkeletonBlock className="h-4 w-1/3" />
        </div>
      </Section>
    );
  }

  if (query.isError) {
    // Cashier / Sales / Customer Service never have organization.read — the
    // Business section simply does not exist for them (not a misleading
    // "restricted" row). A real infra failure still gets a retry affordance.
    if (isPermissionDeniedError(query.error)) return null;
    return (
      <Section title={t("settings.section.business")}>
        <OperationalState
          title={t("settings.business.errorTitle")}
          body={t("settings.business.errorBody")}
          tone="danger"
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }

  const profile = query.data!;

  return (
    <Section title={t("settings.section.business")}>
      <SectionRows>
        <SectionRow label={t("settings.business.name")} value={profile.displayName} />
        <SectionRow label={t("settings.business.slug")} value={profile.slug} />
        {profile.businessType ? (
          <SectionRow label={t("settings.business.type")} value={profile.businessType} />
        ) : null}
        <SectionRow label={t("settings.business.currency")} value={profile.defaultCurrency} />
        <SectionRow label={t("settings.business.country")} value={profile.country} />
      </SectionRows>
    </Section>
  );
}

function AccountSection() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["settings", "account-profile"],
    queryFn: () => getAccountProfileFn(),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <Section title={t("settings.section.account")}>
        <div className="space-y-2 py-1">
          <SkeletonBlock className="h-4 w-2/3" />
          <SkeletonBlock className="h-4 w-1/2" />
        </div>
      </Section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Section title={t("settings.section.account")}>
        <OperationalState
          title={t("settings.account.errorTitle")}
          body={t("settings.account.errorBody")}
          tone="danger"
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }

  const account = query.data!;

  return (
    <Section title={t("settings.section.account")}>
      <SectionRows>
        <SectionRow label={t("settings.account.email")} value={account.email} />
        {account.displayName ? (
          <SectionRow label={t("settings.account.name")} value={account.displayName} />
        ) : null}
      </SectionRows>
    </Section>
  );
}

function AppSection() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();

  return (
    <Section title={t("settings.section.app")}>
      <div className="space-y-2">
        <p className="text-body-sm text-text-secondary">{t("settings.app.language")}</p>
        <SegmentedControl
          label={t("settings.app.language")}
          value={language}
          onChange={setLanguage}
          segments={[
            { value: "km", label: "ខ្មែរ" },
            { value: "en", label: "English" },
          ]}
        />
        <p className="text-caption text-text-muted">{t("settings.app.languageHint")}</p>
      </div>
    </Section>
  );
}

function TeamSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const permissions = permissionsFor(currentRole);

  if (!permissions.manageTeam) return null;

  return (
    <Section title={t("settings.section.team")}>
      <ActionRow
        icon={Users}
        label={t("settings.team.label")}
        description={t("settings.team.description")}
        onClick={() => void navigate({ to: "/app/team" })}
      />
    </Section>
  );
}

function SecuritySection({ onRequestSignOut }: { onRequestSignOut: () => void }) {
  const { t } = useTranslation();

  return (
    <Section title={t("settings.section.security")}>
      <Button
        type="button"
        variant="outline"
        className="tap-target h-12 w-full text-status-danger-text"
        onClick={onRequestSignOut}
      >
        <LogOut className="size-4" aria-hidden />
        {t("settings.security.signOut")}
      </Button>
    </Section>
  );
}

function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutFn();
      // Drop every cached query — protected data must not survive into the
      // next session (another organization, another user) sharing this tab.
      queryClient.clear();
      setSignOutOpen(false);
      await navigate({ to: "/sign-in" });
    } catch {
      notifyError(t("settings.security.signOutError"));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("settings.title")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] space-y-4 px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <p className="text-body-sm px-1 text-text-secondary">{t("settings.subtitle")}</p>

        <BusinessSection />
        <AccountSection />
        <AppSection />
        <TeamSection />
        <SecuritySection onRequestSignOut={() => setSignOutOpen(true)} />
      </main>

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
