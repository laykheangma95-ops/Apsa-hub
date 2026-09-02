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

export function ConversationRow({
  conversation,
  customerName,
  companion,
  assignedStaff,
  onClick,
  className,
}: ConversationRowProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "tap-target flex w-full items-start gap-3 border-b border-border-default bg-surface-primary px-4 py-3 text-left transition-colors hover:bg-surface-secondary",
        className,
      )}
    >
      <span
        aria-hidden
        className="text-label flex size-10 shrink-0 items-center justify-center rounded-full text-text-inverse"
        style={{ backgroundColor: COMPANION_VAR[companion] }}
      >
        {initials(customerName)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-h3 min-w-0 flex-1 truncate text-text-primary">{customerName}</span>
          <ChannelBadge channel={conversation.channel} />
          <span className="text-caption shrink-0 text-text-muted">
            {shortTime(conversation.lastMessageAt)}
          </span>
        </span>
        <span className="text-body-sm mt-0.5 block truncate text-text-secondary">
          {conversation.lastMessage}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-2">
          <StatusChip status={conversation.status} />
          {assignedStaff ? (
            <span
              className="text-caption flex size-5 items-center justify-center rounded-full text-text-inverse"
              style={{ backgroundColor: COMPANION_VAR[assignedStaff.companion] }}
              title={assignedStaff.name}
            >
              {initials(assignedStaff.name)}
            </span>
          ) : null}
        </span>
      </span>

      {conversation.unreadCount > 0 ? (
        <span
          className="text-caption mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-action-primary text-text-on-action"
          aria-label={t("status.unread")}
        >
          {conversation.unreadCount}
        </span>
      ) : null}
    </button>
  );
}
