import { Check, CheckCheck, Clock, X } from "lucide-react";
import { format } from "date-fns";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

interface MessageBubbleProps {
  message: Message;
  attachment?: ReactNode;
  className?: string;
}

export function MessageBubble({ message, attachment, className }: MessageBubbleProps) {
  const { direction, body, at, state } = message;

  if (direction === "system") {
    return (
      <div className={cn("flex justify-center py-2", className)}>
        <span className="text-caption rounded-full bg-surface-secondary px-3 py-1 text-text-secondary">
          {body}
        </span>
      </div>
    );
  }

  const outbound = direction === "outbound";
  const StateIcon =
    state === "failed" ? X : state === "sending" ? Clock : state === "read" ? CheckCheck : Check;

  return (
    <div className={cn("flex w-full", outbound ? "justify-end" : "justify-start", className)}>
      <div
        className={cn(
          "max-w-[78%] rounded-2xl px-3.5 py-2.5",
          outbound
            ? "rounded-br-md bg-action-primary text-text-on-action"
            : "rounded-bl-md bg-surface-secondary text-text-primary",
        )}
      >
        {attachment ? <div className="mb-2">{attachment}</div> : null}
        <p className="text-body break-words">{body}</p>
        <span
          className={cn(
            "text-caption mt-1 flex items-center justify-end gap-1",
            outbound ? "opacity-80" : "text-text-muted",
          )}
        >
          {format(new Date(at), "h:mm a")}
          {outbound && state ? <StateIcon className="size-3" aria-label={state} /> : null}
        </span>
      </div>
    </div>
  );
}
