import { useTranslation } from "react-i18next";
import { OperationalState } from "@/components/common/OperationalState";
import type { CapabilityView } from "@/lib/capabilities";

/**
 * The calm, non-leaky answer for an authenticated member who reached a screen
 * their permissions do not cover.
 *
 * It names no organization, no counts, no customer or order data — a denial
 * must not describe what sits behind it. It distinguishes only two things the
 * member can act on: "you do not have this" and "we could not check right now".
 *
 * This is presentation. The route's data still comes from server functions that
 * authorize independently; a member who bypasses this screen gets a 403, not data.
 */
export function CapabilityDeniedState({
  capabilities,
  className,
}: {
  capabilities: Pick<CapabilityView, "reason">;
  className?: string;
}) {
  const { t } = useTranslation();
  const unresolved = capabilities.reason === "unavailable";

  return (
    <OperationalState
      title={unresolved ? t("capability.unavailable.title") : t("capability.denied.title")}
      body={unresolved ? t("capability.unavailable.body") : t("capability.denied.body")}
      {...(className ? { className } : {})}
    />
  );
}
