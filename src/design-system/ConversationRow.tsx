import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { initials, shortTime } from "@/lib/format";
import { ChannelBadge } from "./ChannelBadge";
import { StatusChip } from "./StatusChip";
import type { Conversation, CompanionColor, Staff } from "@/types";

const COMPANION_VAR: Record<CompanionColor, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

interface ConversationRowProps {
  conversation: Conversation;
  customerName: string;
  companion: CompanionColor;
  assignedStaff?: Staff | undefined;
  onClick?: () => void;
  className?: string | undefined;
}

/**
 * A scan-first row: name and time on the first line, message on the second,
 * follow-up state on the third. Unread weight carries the attention, not colour.
 */
export function ConversationRow({
  conversation,
  customerName,
  companion,
  assignedStaff,
  onClick,
  className,
}: ConversationRowProps) {
  const { t } = useTranslation();
  const unread = conversation.unreadCount > 0;
  const assignedName = assignedStaff?.name ?? conversation.assignedStaffName;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press flex w-full items-start gap-3 bg-surface-primary py-2.5 pr-4 pl-4 text-left hover:bg-surface-secondary",
        className,
      )}
    >
      <span className="relative shrink-0">
        <span
          aria-hidden
          className="text-label flex size-10 items-center justify-center rounded-full text-text-inverse"
          style={{ backgroundColor: COMPANION_VAR[companion] }}
        >
          {initials(customerName)}
        </span>
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface-primary p-0.5"
        >
          <ChannelBadge channel={conversation.channel} />
        </span>
      </span>

      <span className="min-w-0 flex-1 divider-inset pb-2.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-h3 min-w-0 flex-1 truncate",
              unread ? "text-text-primary" : "font-normal text-text-primary",
            )}
          >
            {customerName}
          </span>
          <span className="text-caption tnum shrink-0 text-text-muted">
            {shortTime(conversation.lastMessageAt)}
          </span>
        </span>

        <span className="mt-0.5 flex items-center gap-2">
          <span
            className={cn(
              "text-body-sm min-w-0 flex-1 truncate",
              unread ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {conversation.lastMessage}
          </span>
          {unread ? (
            <span
              className="text-caption tnum flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-action-primary px-1 text-text-on-action"
              aria-label={t("status.unread")}
            >
              {conversation.unreadCount}
            </span>
          ) : null}
        </span>

        <span className="mt-1.5 flex flex-wrap items-center gap-2">
          <StatusChip status={conversation.status} size="sm" />
          {assignedName ? (
            <span
              className="text-caption flex size-5 items-center justify-center rounded-full text-text-inverse"
              style={{ backgroundColor: COMPANION_VAR[assignedStaff?.companion ?? "nilo"] }}
              title={assignedName}
            >
              {initials(assignedName)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
