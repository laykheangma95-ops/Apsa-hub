import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/verify-email")({
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p>Verify your email — coming soon</p>
    </div>
  );
}
