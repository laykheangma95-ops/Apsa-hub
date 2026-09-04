/**
 * Protected application layout — auth guard for all /app/* routes.
 *
 * Security model:
 * - Unauthenticated users → redirect to /auth/sign-in
 * - Authenticated users with no active org membership → redirect to /onboarding
 * - Suspended/removed membership → redirect to /auth/sign-in with denied state
 * - Authenticated users with active membership → render the app
 *
 * This is a UX guard. The actual security boundary is in server-side functions
 * that independently validate the session and membership on every protected operation.
 */
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase/client";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

type MembershipState =
  | "checking"
  | "no_membership"
  | "active"
  | "suspended"
  | "removed";

function AppLayout() {
  const { user, session, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [membershipState, setMembershipState] = useState<MembershipState>("checking");

  // Step 1: Redirect unauthenticated users to sign-in
  useEffect(() => {
    if (loading) return;
    if (!user || !session) {
      void navigate({ to: "/auth/sign-in", replace: true });
    }
  }, [user, session, loading, navigate]);

  // Step 2: Check org membership when session is established
  useEffect(() => {
    if (loading || !user || !session) return;

    setMembershipState("checking");

    void supabase
      .from("memberships")
      .select("status")
      .eq("user_id", user.id)
      .neq("status", "invited")
      .limit(1)
      .then(({ data }) => {
        if (!data || data.length === 0) {
          setMembershipState("no_membership");
          return;
        }
        const row = data[0] as unknown as { status: string } | undefined;
        const status = row?.status ?? "";
        if (status === "active") {
          setMembershipState("active");
        } else if (status === "suspended") {
          setMembershipState("suspended");
        } else {
          setMembershipState("removed");
        }
      }, () => {
        setMembershipState("no_membership");
      });
  }, [user, session, loading]);

  // Step 3: Act on membership state
  useEffect(() => {
    if (membershipState === "no_membership") {
      void navigate({ to: "/onboarding", replace: true });
    } else if (membershipState === "suspended" || membershipState === "removed") {
      void navigate({ to: "/auth/sign-in", replace: true });
    }
  }, [membershipState, navigate]);

  if (loading || membershipState === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-page">
        <p className="text-body text-text-secondary">{t("common.loading")}</p>
      </div>
    );
  }

  if (!user || membershipState !== "active") {
    return null;
  }

  return <Outlet />;
}
