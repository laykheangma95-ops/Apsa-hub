import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/access-denied")({
  component: AccessDeniedPage,
});

function AccessDeniedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-xl font-semibold">Access Denied</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account has been suspended or removed from this organization.
          Contact your organization owner for assistance.
        </p>
      </div>
    </div>
  );
}
