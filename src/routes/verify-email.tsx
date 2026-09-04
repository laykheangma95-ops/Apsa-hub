/**
 * Email verification waiting page — /verify-email
 *
 * Shown after sign-up. User must click the link in their email before
 * they can access any protected APSA business flow.
 *
 * When Supabase sends the confirmation email, the link includes a token.
 * The user clicks the link → Supabase verifies → redirects to emailRedirectTo
 * (which we set to this page in sign-up.tsx). At that point, Supabase updates
 * the session URL hash. We detect the hash, sign in, and redirect to /onboarding.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { setAuthCookieFn } from "@/api/auth";

export const Route = createFileRoute("/verify-email")({
  head: () => ({
    meta: [{ title: "Verify your email — APSA" }],
  }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"waiting" | "confirming" | "error">("waiting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Supabase puts the session data in the URL hash after the user clicks the
    // confirmation link. Detect it and complete the session handshake.
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (!hash.includes("access_token")) return;

    setStatus("confirming");

    (async () => {
      try {
        const { supabase } = await import("@/lib/supabase/client");

        // Let Supabase parse the fragment and exchange for a session
        const { data, error } = await supabase.auth.getSession();

        if (error || !data.session?.access_token) {
          setStatus("error");
          setErrorMsg(error?.message ?? "Could not confirm session");
          return;
        }

        // Persist token in HttpOnly cookie
        await setAuthCookieFn({ data: { accessToken: data.session.access_token } });

        // Clean up the hash from the URL before navigating
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", window.location.pathname);
        }

        await navigate({ to: "/onboarding" });
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Unexpected error");
      }
    })();
  }, [navigate]);

  if (status === "confirming") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">Confirming your email…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            We sent a confirmation link to your inbox. Click it to activate your account.
          </p>
        </div>

        {status === "error" && errorMsg && (
          <p role="alert" className="text-sm text-destructive">
            {errorMsg}
          </p>
        )}

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Already confirmed? Refresh this page or sign in.
          </p>
          <Button variant="outline" className="w-full" asChild>
            <a href="/sign-in">Go to sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
