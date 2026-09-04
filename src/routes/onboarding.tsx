/**
 * Onboarding route — /onboarding
 *
 * Creates the user's first organization. The organization creation goes through
 * a server function (createOrganizationFn in @/api/org) which:
 *   1. Validates the auth cookie server-side (no client-provided identity)
 *   2. Validates and sanitizes input
 *   3. Calls the Postgres RPC (migration 009) — atomic DB transaction
 *   4. Returns a typed result: success | slug_taken | already_member | error
 *
 * Security:
 *   - Route components NEVER import from @/server/* directly (Blocker 1)
 *   - user_id, role_id, organization_id are all determined server-side (Blocker 1)
 *   - Slug uniqueness is enforced by DB constraint, not a pre-check race (Blocker 6)
 *   - Retry-safe: if the same user submits twice, the second attempt gets
 *     'already_member' and the UI redirects to /app instead (Blocker 6)
 */

import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganizationFn } from "@/api/org";
import { getSessionFn } from "@/api/auth";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [{ title: "Set up your business — APSA" }],
  }),
  beforeLoad: async () => {
    // Must be authenticated with verified email to reach onboarding.
    // If already has an org, skip onboarding.
    const session = await getSessionFn();
    if (session.status === "unauthenticated") throw redirect({ to: "/sign-in" });
    if (session.status === "unverified") throw redirect({ to: "/verify-email" });
    if (session.status === "revoked") throw redirect({ to: "/access-denied" });
    if (session.status === "ok") throw redirect({ to: "/app" });
    // status === "no_org": proceed with onboarding
  },
  component: OnboardingPage,
});

// Slug generation from business name
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function OnboardingPage() {
  const navigate = useNavigate();

  const [legalName, setLegalName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [businessType, setBusinessType] = useState("");
  const [currency, setCurrency] = useState<"USD" | "KHR">("USD");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function handleNameChange(v: string) {
    setLegalName(v);
    // Auto-generate slug unless user has manually edited it
    if (!slugManuallyEdited) {
      setSlug(toSlug(v));
    }
  }

  function handleSlugChange(v: string) {
    setSlugManuallyEdited(true);
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Client-side validation — DB constraint is the authority, this is UX only
    if (slug.length < 2) {
      setError("Short name must be at least 2 characters");
      setLoading(false);
      return;
    }
    if (/^-|-$/.test(slug)) {
      setError("Short name must not start or end with a hyphen");
      setLoading(false);
      return;
    }

    try {
      const result = await createOrganizationFn({
        data: {
          legalName: legalName.trim(),
          slug,
          businessType: businessType.trim() || undefined,
          defaultCurrency: currency,
        },
      });

      if (!result.ok) {
        switch (result.code) {
          case "slug_taken":
            setError(
              `The short name "${slug}" is already taken. Please choose another.`,
            );
            break;

          case "already_member":
            // Idempotent retry: user already created an org — redirect to app
            await navigate({ to: "/app" });
            return;

          case "founder_not_found":
            setError("Account setup incomplete. Please sign out and sign in again.");
            break;

          default:
            setError("Something went wrong. Please try again.");
            break;
        }
        return;
      }

      // Success: organization created atomically
      await navigate({ to: "/app" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Set up your business
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This takes 30 seconds. You can change everything later.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="legalName">Business name</Label>
            <Input
              id="legalName"
              type="text"
              required
              minLength={2}
              maxLength={200}
              value={legalName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Sok Fashion Store"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="slug">
              Short name{" "}
              <span className="text-xs font-normal text-muted-foreground">(URL-safe ID)</span>
            </Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">apsa.io/</span>
              <Input
                id="slug"
                type="text"
                required
                minLength={2}
                maxLength={63}
                pattern="^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="sok-fashion"
                className="flex-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and hyphens only
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="businessType">
              Business type{" "}
              <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="businessType"
              type="text"
              maxLength={100}
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              placeholder="Fashion, Food, Electronics…"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Default currency</Label>
            <div className="flex gap-3">
              {(["USD", "KHR"] as const).map((c) => (
                <label key={c} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="currency"
                    value={c}
                    checked={currency === c}
                    onChange={() => setCurrency(c)}
                    className="accent-primary"
                  />
                  <span className="text-sm">{c}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={loading || !legalName.trim() || slug.length < 2}
          >
            {loading ? "Creating your workspace…" : "Create business"}
          </Button>
        </form>
      </div>
    </div>
  );
}
