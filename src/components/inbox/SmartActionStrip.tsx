import { useTranslation } from "react-i18next";
import { Chip } from "@/design-system";
import type { SmartActionId, SmartActionSuggestion } from "@/lib/conversation/smart-actions";

interface SmartActionStripProps {
  suggestion: SmartActionSuggestion;
  onAction: (action: SmartActionId) => void;
}

/**
 * The compact suggestion strip near the composer (Smart Actions Phase 1).
 *
 * One primary action, at most two secondary — never a wall of buttons (§
 * ACTION PRIORITY). Renders nothing when the engine found nothing worth
 * acting on, so an ordinary reply-only thread stays exactly as uncluttered as
 * it is today.
 */
export function SmartActionStrip({ suggestion, onAction }: SmartActionStripProps) {
  const { t } = useTranslation();
  const { primary, secondary } = suggestion;

  if (!primary) return null;

  const actions = [primary, ...secondary];

  return (
    <nav aria-label={t("conversation.intent.stripTitleOne")} className="mb-2">
      <p className="text-caption mb-1.5 px-1 text-text-muted">
        {t(
          actions.length > 1
            ? "conversation.intent.stripTitleMany"
            : "conversation.intent.stripTitleOne",
        )}
      </p>
      <div className="scrollbar-none flex gap-2 overflow-x-auto px-0.5 pb-0.5">
        {actions.map((action, index) => (
          <Chip
            key={action}
            selected={index === 0}
            onClick={() => onAction(action)}
            ariaLabel={t(`conversation.intent.actions.${action}`)}
          >
            {t(`conversation.intent.actions.${action}`)}
          </Chip>
        ))}
      </div>
    </nav>
  );
}
