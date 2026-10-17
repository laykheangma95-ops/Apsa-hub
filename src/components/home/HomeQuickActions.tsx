import { ClipboardPlus, Inbox, PackageCheck, ShoppingBag, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { GlassActionTile, type GlassTileTone } from "@/design-system";
import type { HomeQuickActionId, HomeQuickActionState } from "@/lib/home-quick-actions";

const ICON: Record<HomeQuickActionId, LucideIcon> = {
  newSale: ShoppingBag,
  newOrder: ClipboardPlus,
  packOrders: PackageCheck,
  inbox: Inbox,
};

/** One blue family; each tile only changes the colour of its light. */
const TONE: Record<HomeQuickActionId, GlassTileTone> = {
  newSale: "sky",
  newOrder: "teal",
  packOrders: "violet",
  inbox: "ice",
};

interface HomeQuickActionsProps {
  actions: readonly HomeQuickActionState[];
  onAction: (action: HomeQuickActionState) => void;
  gridRef: React.Ref<HTMLDivElement>;
  /** From useHeldTileSize (src/hooks/use-held-tile-size.ts); null lets the tiles fit the screen. */
  heldSize: number | null;
}

/** Home's four primary starting points, 2 × 2, sized to the space left on screen. */
export function HomeQuickActions({ actions, onAction, gridRef, heldSize }: HomeQuickActionsProps) {
  const { t } = useTranslation();
  const style =
    heldSize === null ? undefined : ({ "--tile-frozen": `${heldSize}px` } as CSSProperties);

  return (
    <section
      aria-labelledby="actions-heading"
      className="home-actions"
      data-frozen={heldSize === null ? undefined : ""}
      style={style}
    >
      {/* The tiles name themselves; the heading is for screen-reader navigation. */}
      <h2 id="actions-heading" className="sr-only">
        {t("home.quickActions")}
      </h2>
      <div ref={gridRef} className="home-actions-grid">
        {actions.map((action) => (
          <GlassActionTile
            key={action.id}
            icon={ICON[action.id]}
            tone={TONE[action.id]}
            title={t(`home.quick.${action.id}.title`)}
            description={t(`home.quick.${action.id}.description`)}
            unavailableLabel={t("home.quick.unavailable")}
            onPress={action.available ? () => onAction(action) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
