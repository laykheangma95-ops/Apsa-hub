import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p>Onboarding — coming soon</p>
    </div>
  );
}
