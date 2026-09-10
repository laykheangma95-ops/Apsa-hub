/**
 * Accept a staff invitation.
 *
 * No email/SMS delivery exists yet (see src/server/team) — the owner shares
 * this link directly, and this page is where it lands. Deliberately minimal,
 * matching the current state of the other pre-app auth pages in this
 * codebase (src/routes/verify-email.tsx, sign-in.tsx): functional, not a
 * Product Polish Pass target.
 *
 * Security: the token proves the invitation, not identity — acceptance
 * still requires an authenticated, email-verified session whose email
 * matches the invited address. All of that is re-verified server-side by
 * acceptInvitationFn / the accept_invitation() RPC; this page only decides
 * what to show.
 *
 * Error handling: both the preview load and the accept call are network
 * requests and can fail for reasons that have nothing to do with the
 * invitation itself (offline, a 5xx, a timeout). Every branch below is
 * try/caught so a failure always lands on a visible, recoverable error
 * state — never an infinite "loading"/"accepting" spinner or a button that
 * silently stops responding.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";

export const Route = createFileRoute("/invite/$token")({
  head: () => ({
    meta: [{ title: "Team invite - APSA" }],
  }),
  component: InviteAcceptPage,
});

type PreviewState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "already_used" }
  | {
      kind: "pending";
      organizationName?: string;
      role: string;
      invitedEmail: string;
      emailMatchesCaller?: boolean;
      callerEmail: string;
    };

type AcceptState =
  | { kind: "idle" }
  | { kind: "accepting" }
  | { kind: "success" }
  | { kind: "already_member" }
  | {
      kind: "error";
      code: "not_found" | "expired" | "already_used" | "email_mismatch" | "generic";
    };

function InviteAcceptPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token } = Route.useParams();

  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [acceptState, setAcceptState] = useState<AcceptState>({ kind: "idle" });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { getInvitationPreviewFn } = await import("@/api/team");
        const result = await getInvitationPreviewFn({ data: { token } });
        if (cancelled) return;
        if (result.status === "unauthenticated") {
          setPreview({ kind: "unauthenticated" });
        } else if (result.status === "pending") {
          setPreview({
            kind: "pending",
            ...(result.organizationName ? { organizationName: result.organizationName } : {}),
            role: result.role ?? "",
            invitedEmail: result.invitedEmail ?? "",
            ...(result.emailMatchesCaller !== undefined
              ? { emailMatchesCaller: result.emailMatchesCaller }
              : {}),
            callerEmail: result.callerEmail,
          });
        } else {
          setPreview({ kind: result.status });
        }
      } catch {
        // Network failure, server error, etc. — never leave the page stuck
        // on "Checking your invite…" forever.
        if (!cancelled) setPreview({ kind: "error" });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, loadAttempt]);

  function retryLoad() {
    setPreview({ kind: "loading" });
    setLoadAttempt((n) => n + 1);
  }

  async function accept() {
    setAcceptState({ kind: "accepting" });
    try {
      const { acceptInvitationFn } = await import("@/api/team");
      const result = await acceptInvitationFn({ data: { token } });
      if (result.ok) {
        setAcceptState({ kind: result.alreadyMember ? "already_member" : "success" });
        return;
      }
      if (result.code === "unauthenticated") {
        // Session expired between preview and accept — send them back through
        // the sign-in prompt rather than reporting a generic failure.
        setPreview({ kind: "unauthenticated" });
        setAcceptState({ kind: "idle" });
        return;
      }
      setAcceptState({
        kind: "error",
        code:
          result.code === "not_found" ||
          result.code === "expired" ||
          result.code === "already_used" ||
          result.code === "email_mismatch"
            ? result.code
            : "generic",
      });
    } catch {
      // Network failure, timeout, unexpected 5xx — the button must not stay
      // permanently disabled on "Joining…".
      setAcceptState({ kind: "error", code: "generic" });
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          {t("inviteAccept.title")}
        </h1>

        {preview.kind === "loading" ? (
          <p className="text-center text-sm text-muted-foreground" role="status">
            {t("inviteAccept.loading")}
          </p>
        ) : null}

        {preview.kind === "error" ? (
          <OperationalState
            title={t("inviteAccept.title")}
            body={t("inviteAccept.loadError")}
            tone="danger"
            onRetry={retryLoad}
          />
        ) : null}

        {preview.kind === "unauthenticated" ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">{t("inviteAccept.afterAuthHint")}</p>
            <div className="flex gap-2">
              <Button asChild className="h-12 flex-1">
                <Link to="/sign-in">{t("inviteAccept.signIn")}</Link>
              </Button>
              <Button asChild variant="outline" className="h-12 flex-1">
                <Link to="/sign-up">{t("inviteAccept.signUp")}</Link>
              </Button>
            </div>
          </div>
        ) : null}

        {preview.kind === "not_found" ? (
          <OperationalState
            title={t("inviteAccept.title")}
            body={t("inviteAccept.notFound")}
            tone="danger"
          />
        ) : null}
        {preview.kind === "expired" ? (
          <OperationalState
            title={t("inviteAccept.title")}
            body={t("inviteAccept.expired")}
            tone="danger"
          />
        ) : null}
        {preview.kind === "already_used" ? (
          <OperationalState
            title={t("inviteAccept.title")}
            body={t("inviteAccept.alreadyUsed")}
            tone="danger"
          />
        ) : null}

        {preview.kind === "pending" ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-foreground">
              {t("inviteAccept.summary", {
                org: preview.organizationName ?? "",
                role: t(`team.role.${preview.role}`),
              })}
            </p>

            {preview.emailMatchesCaller === false ? (
              <OperationalState
                title={t("inviteAccept.title")}
                body={t("inviteAccept.emailMismatch", {
                  invitedEmail: preview.invitedEmail,
                  yourEmail: preview.callerEmail,
                })}
                tone="danger"
              />
            ) : acceptState.kind === "success" || acceptState.kind === "already_member" ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground">
                  {acceptState.kind === "success"
                    ? t("inviteAccept.success", { org: preview.organizationName ?? "" })
                    : t("inviteAccept.alreadyMember")}
                </p>
                <Button className="h-12 w-full" onClick={() => void navigate({ to: "/app" })}>
                  {t("inviteAccept.goToApp")}
                </Button>
              </div>
            ) : acceptState.kind === "error" ? (
              <OperationalState
                title={t("inviteAccept.title")}
                body={
                  acceptState.code === "not_found"
                    ? t("inviteAccept.notFound")
                    : acceptState.code === "expired"
                      ? t("inviteAccept.expired")
                      : acceptState.code === "already_used"
                        ? t("inviteAccept.alreadyUsed")
                        : acceptState.code === "email_mismatch"
                          ? t("inviteAccept.emailMismatch", {
                              invitedEmail: preview.invitedEmail,
                              yourEmail: preview.callerEmail,
                            })
                          : t("inviteAccept.acceptError")
                }
                tone="danger"
                onRetry={() => setAcceptState({ kind: "idle" })}
              />
            ) : (
              <Button
                className="h-12 w-full"
                disabled={acceptState.kind === "accepting"}
                onClick={() => void accept()}
              >
                {acceptState.kind === "accepting"
                  ? t("inviteAccept.accepting")
                  : t("inviteAccept.accept")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
