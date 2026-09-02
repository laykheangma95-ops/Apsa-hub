import { Facebook, Instagram, Send, Store, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Channel } from "@/types";

const ICONS: Record<Channel, LucideIcon> = {
  facebook: Facebook,
  instagram: Instagram,
  telegram: Send,
  pos: Store,
};

const COLOR_VAR: Record<Channel, string> = {
  facebook: "var(--channel-facebook)",
  instagram: "var(--channel-instagram)",
  telegram: "var(--channel-telegram)",
  pos: "var(--channel-pos)",
};

interface ChannelBadgeProps {
  channel: Channel;
  withLabel?: boolean;
  className?: string;
}

/** Channel colour always ships with its icon — never colour alone. */
export function ChannelBadge({ channel, withLabel = false, className }: ChannelBadgeProps) {
  const { t } = useTranslation();
  const Icon = ICONS[channel];
  const label = t(`channel.${channel}`);

  return (
    <span
      className={cn("inline-flex items-center gap-1 text-caption text-text-secondary", className)}
      title={label}
    >
      <Icon className="size-3.5 shrink-0" style={{ color: COLOR_VAR[channel] }} aria-hidden />
      {withLabel ? <span className="chip-text">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
