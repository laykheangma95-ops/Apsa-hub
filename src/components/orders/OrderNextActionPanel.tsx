import { Link } from "@tanstack/react-router";
import { Check, Circle, CircleDot, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Section, Spinner } from "@/design-system";
import type {
  OrderActionId,
  OrderActionItem,
  OrderNextAction,
  WorkflowStep,
} from "@/lib/order-next-action";
import { cn } from "@/lib/utils";

/** In-screen actions: the panel calls back; the screen runs its existing sheet or mutation. */
export type OrderNextActionHandlers = Partial<
  Record<"confirm_order" | "complete_order" | "record_payment" | "arrange_delivery", () => void>
>;

interface OrderNextActionPanelProps {
  next: OrderNextAction;
  handlers: OrderNextActionHandlers;
  /** The in-screen action currently in flight, if any. */
  pendingAction: OrderActionId | null;
  /** Re-reads what the decision depends on; offered when next.retryable. */
  onRetry: () => void;
}

const STEP_ICON: Record<WorkflowStep["state"], ReactNode> = {
  done: <Check className="size-4" aria-hidden />,
  current: <CircleDot className="size-4" aria-hidden />,
  upcoming: <Circle className="size-4" aria-hidden />,
  cancelled: <X className="size-4" aria-hidden />,
};

const STEP_TONE: Record<WorkflowStep["state"], string> = {
  done: "bg-status-success-soft text-status-success-text",
  current: "bg-status-info-soft text-status-info-text",
  upcoming: "bg-status-neutral-soft text-status-neutral-text",
  cancelled: "bg-status-danger-soft text-status-danger-text",
};

const PRIMARY_CLASS =
  "press-tactile tap-target text-label flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-4 py-2 text-center";

/**
 * Order detail's one "what happens next" area: the four-step workflow (Order →
 * Payment → Packing → Delivery / hand-over), a plain explanation, and at most
 * one primary action. Everything it shows comes from deriveOrderNextAction; it
 * decides nothing itself, and the server re-checks every action it starts.
 */
export function OrderNextActionPanel({
  next,
  handlers,
  pendingAction,
  onRetry,
}: OrderNextActionPanelProps) {
  const { t } = useTranslation();
  const navigating = next.secondary.filter(
    (
      item,
    ): item is OrderActionItem & { destination: NonNullable<OrderActionItem["destination"]> } =>
      item.destination !== null,
  );

  return (
    <Section title={t("order.next.title")}>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("order.next.workflow")}>
        {next.steps.map((step) => (
          <li key={step.key} className="flex min-w-0 items-start gap-2">
            <span
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                STEP_TONE[step.state],
              )}
            >
              {STEP_ICON[step.state]}
            </span>
            <span className="min-w-0">
              <span className="text-label block text-text-primary">
                {t(`order.next.step.${step.key}`)}
                <span className="sr-only">
                  {" — "}
                  {t(`order.next.stepState.${step.state}`)}
                </span>
              </span>
              <span className="text-caption block break-words text-text-secondary">
                {t(step.detailKey)}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4 border-t border-border-default pt-3" aria-live="polite">
        {next.status === "loading" ? (
          <p role="status" className="text-body-sm flex items-center gap-2 text-text-secondary">
            <Spinner />
            {t(next.reasonKey)}
          </p>
        ) : (
          <p className="text-body-sm text-text-primary">{t(next.reasonKey)}</p>
        )}
        {next.paymentNoteKey ? (
          <p className="text-caption mt-1 text-text-secondary">{t(next.paymentNoteKey)}</p>
        ) : null}

        {next.retryable ? (
          <Button
            type="button"
            variant="outline"
            className="tap-target mt-3 h-11 w-full rounded-xl"
            onClick={onRetry}
          >
            {t("common.retry")}
          </Button>
        ) : null}

        {next.primary ? (
          <div className="mt-3">
            <PrimaryAction item={next.primary} handlers={handlers} pendingAction={pendingAction} />
          </div>
        ) : null}

        {navigating.length > 0 ? (
          <div className="mt-2 flex flex-col">
            {navigating.map((item) => (
              <ActionLink
                key={item.id}
                item={item}
                className="tap-target text-label flex min-h-11 items-center justify-center rounded-xl px-3 text-action-primary"
              >
                {t(`order.next.action.${item.id}`)}
              </ActionLink>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function PrimaryAction({
  item,
  handlers,
  pendingAction,
}: {
  item: OrderActionItem;
  handlers: OrderNextActionHandlers;
  pendingAction: OrderActionId | null;
}) {
  const { t } = useTranslation();
  const label = t(`order.next.action.${item.id}`);

  if (item.destination) {
    return (
      <ActionLink item={item} className={cn(PRIMARY_CLASS, "bg-brand-primary text-white")}>
        {label}
      </ActionLink>
    );
  }

  const handler =
    item.id === "confirm_order" ||
    item.id === "complete_order" ||
    item.id === "record_payment" ||
    item.id === "arrange_delivery"
      ? handlers[item.id]
      : undefined;
  // An in-screen action the screen cannot run is never drawn as executable.
  if (!handler) return null;

  const pending = pendingAction === item.id;
  return (
    <Button
      type="button"
      className="press-tactile tap-target elevation-action h-auto min-h-12 w-full rounded-2xl whitespace-normal"
      disabled={pendingAction !== null}
      aria-busy={pending}
      onClick={handler}
    >
      {pending ? <Spinner /> : null}
      {label}
    </Button>
  );
}

function ActionLink({
  item,
  className,
  children,
}: {
  item: OrderActionItem;
  className: string;
  children: ReactNode;
}) {
  const destination = item.destination;
  if (!destination) return null;
  switch (destination.to) {
    case "/app/pack/$orderId":
      return (
        <Link to={destination.to} params={destination.params} className={cn("press", className)}>
          {children}
        </Link>
      );
    case "/app/handoff/$parcelCode":
      return (
        <Link to={destination.to} params={destination.params} className={cn("press", className)}>
          {children}
        </Link>
      );
    case "/app/deliveries/$id":
      return (
        <Link to={destination.to} params={destination.params} className={cn("press", className)}>
          {children}
        </Link>
      );
    case "/app/payments/$id":
      return (
        <Link to={destination.to} params={destination.params} className={cn("press", className)}>
          {children}
        </Link>
      );
    case "/app/payments":
      return (
        <Link to={destination.to} className={cn("press", className)}>
          {children}
        </Link>
      );
    case "/app/returns/new":
      return (
        <Link to={destination.to} className={cn("press", className)}>
          {children}
        </Link>
      );
  }
}
