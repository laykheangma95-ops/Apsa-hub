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

/**
 * Threads the merchant is expected to act on. These get the accent rail; a
 * thread that is merely open does not, so the rail keeps meaning in a list of
 * fifty. It is reinforcement only — the status chip below still carries the
 * icon and the word.
 */
const NEEDS_ACTION = new Set(["unread", "needs_reply", "follow_up"]);

interface ConversationRowProps {
  conversation: Conversation;
  customerName: string;
  companion: CompanionColor;
  assignedStaff?: Staff | undefined;
  onClick?: () => void;
  className?: string | undefined;
}

/**
 * A scan-first row, read top-down in the order a merchant asks the questions:
 * who is this, what did they say, what state is it in.
 *
 * Everything sits on three lines at any width — the status line wraps rather
 * than truncating, because a clipped Khmer status word is unreadable (Khmer
 * has no inter-word spaces for the ellipsis to fall on).
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
  const needsAction = unread || NEEDS_ACTION.has(conversation.status);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press relative flex w-full items-start gap-3 bg-surface-primary py-2.5 pr-4 pl-4 text-left hover:bg-surface-secondary",
        className,
      )}
    >
      {needsAction ? (
        <span
          aria-hidden
          className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-action-primary"
        />
      ) : null}

      <span className="relative shrink-0">
        <span
          aria-hidden
          className="text-label flex size-11 items-center justify-center rounded-full text-text-inverse"
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

      <span className="divider-inset min-w-0 flex-1 pb-2.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-h3 min-w-0 flex-1 truncate",
              unread ? "font-semibold text-text-primary" : "font-normal text-text-primary",
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
              unread ? "font-medium text-text-primary" : "text-text-secondary",
            )}
          >
            {conversation.lastMessage}
          </span>
          {unread ? (
            <span
              className="text-caption tnum flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-action-primary px-1.5 text-text-on-action"
              aria-label={t("inbox.unreadCount", { count: conversation.unreadCount })}
            >
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          ) : null}
        </span>

        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusChip status={conversation.status} size="sm" />
          {assignedName ? (
            <span className="text-caption inline-flex items-center gap-1 text-text-muted">
              <span
                aria-hidden
                className="text-caption flex size-[18px] items-center justify-center rounded-full text-[9px] text-text-inverse"
                style={{ backgroundColor: COMPANION_VAR[assignedStaff?.companion ?? "nilo"] }}
              >
                {initials(assignedName)}
              </span>
              <span className="chip-text">{assignedName}</span>
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
