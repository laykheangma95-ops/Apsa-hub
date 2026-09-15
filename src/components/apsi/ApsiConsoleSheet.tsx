/**
 * Apsi — APSA's business service console.
 *
 * Not a chatbot. Its one job is "help the staff member answer the customer in
 * front of them", so it opens as a command surface with a search field and the
 * service shortcuts already on screen, never as an empty conversation.
 *
 * Three things it deliberately does NOT do:
 *
 *   - It does not navigate away. It is a BottomSheet over the current route,
 *     so a conversation stays behind it while an order is looked up.
 *   - It does not own any workflow. Every result card routes into the domain
 *     screen that owns the record; recording a payment or arranging a delivery
 *     happens there, under that domain's own confirmations and audit trail.
 *   - It does not answer from itself. Every fact comes from the domain's own
 *     server function, permission-checked there; what a domain will not tell
 *     Apsi, Apsi does not tell the merchant.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/design-system/BottomSheet";
import { StatusChip } from "@/design-system/StatusChip";
import {
  PaymentStatusChip,
  PaymentVerificationChip,
} from "@/components/payments/PaymentStateChips";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useAppPrincipal } from "@/hooks/use-app-principal";
import { apsiKeys } from "@/lib/apsi-query";
import { APSI_QUERY_MAX_LENGTH, classifyApsiQuery } from "@/lib/apsi/input";
import { apsiSurfaceForPath, orderApsiActionIds } from "@/lib/apsi/context";
import {
  APSI_PROBE_PERMISSION,
  apsiResultRoute,
  planApsiLookup,
  runApsiLookup,
  type ApsiResult,
} from "@/lib/apsi/lookup";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type {
  MobileNavActionConfig,
  MobileNavRoute,
  MobileNavSheetGroup,
} from "@/design-system/mobile-nav-config";
import type { StatusKey } from "@/types";

interface ApsiConsoleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shortcut groups, already filtered to what this member can reach. */
  groups: readonly MobileNavSheetGroup[];
  onRoute: (to: MobileNavRoute) => void;
}

export function ApsiConsoleSheet({ open, onOpenChange, groups, onRoute }: ApsiConsoleSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const principal = useAppPrincipal();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");

  const surface = apsiSurfaceForPath(pathname);
  const orderedGroups = useMemo(() => orderGroups(groups, surface), [groups, surface]);

  const plan = useMemo(() => classifyApsiQuery(submitted), [submitted]);

  /*
   * The withheld set is computed WITHOUT issuing anything, so the console can
   * say "this lookup needs a permission you do not have" having never asked
   * the server for the data behind it.
   */
  const withheld = useMemo(() => planApsiLookup(plan, capabilities).skipped, [plan, capabilities]);

  /*
   * Cache identity is the principal from the /app route guard plus the
   * normalized query. Outside /app (the design gallery) there is no principal,
   * so nothing is cached and nothing is fetched — the console there is the
   * shortcut list only.
   */
  const lookup = useQuery({
    queryKey: principal
      ? apsiKeys.lookup(principal.userId, principal.organizationId, plan.normalized)
      : [],
    queryFn: () => runApsiLookup(plan, capabilities),
    enabled: open && Boolean(principal) && !plan.empty,
    staleTime: 15_000,
  });

  function submit(value: string) {
    setSubmitted(value.slice(0, APSI_QUERY_MAX_LENGTH));
  }

  function clear() {
    setDraft("");
    setSubmitted("");
  }

  function openResult(result: ApsiResult) {
    const route = apsiResultRoute(result);
    onOpenChange(false);
    void navigate({ to: route.to, params: { id: route.id } });
  }

  const outcome = lookup.data;
  const searching = !plan.empty && lookup.isPending;
  const nothingFound =
    Boolean(outcome) && outcome!.results.length === 0 && outcome!.failed.length === 0;

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("apsi.title")}
      description={t("apsi.lead")}
      snap="full"
    >
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
        className="sticky top-0 z-10 -mx-1 bg-surface-primary px-1 pb-3"
      >
        <label htmlFor="apsi-console-search" className="sr-only">
          {t("apsi.searchLabel")}
        </label>
        <div className="flex items-center gap-2 rounded-2xl border border-border-default bg-surface-secondary px-3 py-2 focus-within:border-action-primary">
          <Search className="size-4 shrink-0 text-text-muted" aria-hidden />
          <input
            id="apsi-console-search"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={APSI_QUERY_MAX_LENGTH}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("apsi.searchPlaceholder")}
            aria-describedby="apsi-console-scope"
            className="text-body min-w-0 flex-1 bg-transparent py-1 text-text-primary outline-none placeholder:text-text-muted"
          />
          {draft || submitted ? (
            <button
              type="button"
              onClick={clear}
              aria-label={t("apsi.clearSearch")}
              className="tap-target flex size-8 items-center justify-center rounded-full text-text-muted hover:text-text-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
        {/*
         * What the search actually covers, stated up front. A console that
         * silently searches four of the six things a merchant expects returns
         * "nothing found" for a customer who is right there in the database.
         */}
        <p id="apsi-console-scope" className="text-caption mt-2 px-1 text-text-muted">
          {t("apsi.searchScope")}
        </p>
      </form>

      {plan.empty ? (
        <ShortcutGroups groups={orderedGroups} onRoute={onRoute} />
      ) : (
        <div className="space-y-4">
          {plan.unsupported.length > 0 ? (
            <ul className="space-y-2">
              {plan.unsupported.map((item) => (
                <li
                  key={item}
                  className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-3 text-text-secondary"
                >
                  {t(`apsi.unsupported.${item}`)}
                </li>
              ))}
            </ul>
          ) : null}

          {withheld.length > 0 ? (
            <ul className="space-y-2">
              {[...new Set(withheld.map((probe) => APSI_PROBE_PERMISSION[probe.kind]))].map(
                (permission) => (
                  <li
                    key={permission}
                    className="text-body-sm rounded-2xl border border-border-default bg-surface-secondary px-4 py-3 text-text-secondary"
                  >
                    {t("apsi.withheld", { permission })}
                  </li>
                ),
              )}
            </ul>
          ) : null}

          {searching ? (
            <div className="space-y-2" aria-live="polite">
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="h-[84px] animate-pulse rounded-2xl bg-surface-secondary"
                />
              ))}
            </div>
          ) : null}

          {outcome && outcome.failed.length > 0 ? (
            <div className="text-body-sm rounded-2xl border border-status-danger-soft bg-status-danger-soft px-4 py-3 text-status-danger-text">
              <p>{t("apsi.partialFailure")}</p>
              <button
                type="button"
                onClick={() => void lookup.refetch()}
                className="tap-target mt-2 underline underline-offset-2"
              >
                {t("apsi.retry")}
              </button>
            </div>
          ) : null}

          {outcome && outcome.results.length > 0 ? (
            <ul className="list-enter space-y-2" aria-live="polite">
              {outcome.results.map((result) => (
                <li key={`${result.kind}:${result.id}`}>
                  <ResultCard result={result} onOpen={() => openResult(result)} />
                </li>
              ))}
            </ul>
          ) : null}

          {nothingFound ? (
            <p
              className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary"
              aria-live="polite"
            >
              {t("apsi.noResults", { query: plan.normalized })}
            </p>
          ) : null}

          <section className="border-t border-border-default pt-4">
            <h3 className="text-label px-1 pb-2 text-text-muted">{t("apsi.openDomain")}</h3>
            <ShortcutGroups groups={orderedGroups} onRoute={onRoute} />
          </section>
        </div>
      )}
    </BottomSheet>
  );
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────

function orderGroups(
  groups: readonly MobileNavSheetGroup[],
  surface: ReturnType<typeof apsiSurfaceForPath>,
): readonly MobileNavSheetGroup[] {
  return groups.map((group) => {
    const ids = orderApsiActionIds(
      group.actions.map((action) => action.id),
      surface,
    );
    const byId = new Map(group.actions.map((action) => [action.id, action]));
    return {
      ...group,
      actions: ids.map((id) => byId.get(id)!).filter(Boolean),
    };
  });
}

function ShortcutGroups({
  groups,
  onRoute,
}: {
  groups: readonly MobileNavSheetGroup[];
  onRoute: (to: MobileNavRoute) => void;
}) {
  const { t } = useTranslation();

  if (groups.length === 0) {
    return (
      <p className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary">
        {t("apsi.noTools")}
      </p>
    );
  }

  return (
    <div className="list-enter space-y-5">
      {groups.map((group) => (
        <section key={group.id}>
          <h3 className="text-label px-1 pb-2 text-text-muted">{t(group.titleKey)}</h3>
          <div className="list-enter space-y-2">
            {group.actions.map((action) => (
              <ShortcutRow key={action.id} action={action} onRoute={onRoute} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ShortcutRow({
  action,
  onRoute,
}: {
  action: MobileNavActionConfig;
  onRoute: (to: MobileNavRoute) => void;
}) {
  const { t } = useTranslation();
  const disabled = action.availability === "coming-soon";

  return (
    <button
      type="button"
      className={cn(
        "press flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        disabled
          ? "cursor-not-allowed border-border-default bg-surface-secondary/75 text-text-muted"
          : "border-border-default bg-surface-primary text-text-primary hover:bg-surface-secondary/72 active:bg-surface-secondary",
      )}
      onClick={action.to ? () => onRoute(action.to!) : undefined}
      disabled={disabled}
      aria-disabled={disabled}
    >
      <span
        className={cn(
          "mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl",
          disabled
            ? "bg-surface-primary text-text-muted"
            : "bg-action-primary-soft text-action-primary",
        )}
      >
        <action.icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-body block text-left">{t(action.labelKey)}</span>
          {disabled ? (
            <span className="rounded-full bg-surface-primary px-2 py-0.5 text-[10px] font-medium leading-4 text-text-muted">
              {t("nav.comingSoon")}
            </span>
          ) : (
            <span className="rounded-full bg-action-primary-soft px-2 py-0.5 text-[10px] font-medium leading-4 text-action-primary">
              {t("nav.opensExisting")}
            </span>
          )}
        </span>
        <span className="text-body-sm mt-1 block text-left text-text-secondary">
          {t(action.descriptionKey)}
        </span>
      </span>
      {!disabled ? (
        <ChevronRight className="mt-1 size-4 shrink-0 text-text-muted" aria-hidden />
      ) : null}
    </button>
  );
}

// ── Result cards ──────────────────────────────────────────────────────────────

/**
 * One concise operational card per record. Every value below was produced by
 * the owning domain — nothing here derives a status, sums money, or fills in a
 * field the server withheld.
 */
function ResultCard({ result, onOpen }: { result: ApsiResult; onOpen: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onOpen}
      className="press flex w-full flex-col gap-2 rounded-2xl border border-border-default bg-surface-primary px-4 py-3 text-left hover:bg-surface-secondary/72"
    >
      <span className="text-caption text-text-muted">{t(`apsi.card.${result.kind}`)}</span>
      <ResultBody result={result} />
      <span className="text-body-sm inline-flex items-center gap-1 text-action-primary">
        {t(`apsi.open.${result.kind}`)}
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </button>
  );
}

function ResultBody({ result }: { result: ApsiResult }) {
  const { t } = useTranslation();

  switch (result.kind) {
    case "order":
      return (
        <>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
              {result.code}
            </span>
            <span className="text-financial shrink-0 text-text-primary">
              {formatMoney(result.total)}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {result.lifecycleStatus ? (
              <StatusChip status={result.lifecycleStatus as StatusKey} />
            ) : null}
            <StatusChip status={result.paymentStatus as StatusKey} />
            <StatusChip status={result.fulfillmentStatus as StatusKey} />
          </span>
        </>
      );

    case "payment":
      return (
        <>
          <span className="text-financial block text-text-primary">
            {formatMoney(result.amount)}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <PaymentStatusChip status={result.status} />
            <PaymentVerificationChip state={result.verificationState} />
          </span>
        </>
      );

    case "delivery":
      return (
        <>
          <span className="text-label block truncate text-text-primary">
            {result.orderCode ?? t("apsi.card.deliveryNoOrderCode")}
          </span>
          <span className="text-body-sm block truncate text-text-secondary">
            {result.providerName}
            {result.trackingNumber ? ` · ${result.trackingNumber}` : ""}
            {result.customerName ? ` · ${result.customerName}` : ""}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusChip status={result.status as StatusKey} />
          </span>
        </>
      );

    case "customer":
      return (
        <>
          <span className="text-label block truncate text-text-primary">{result.name}</span>
          <span className="text-body-sm block truncate text-text-secondary">
            {/*
             * The phone is shown only when the SERVER sent one. It withholds
             * the value itself without customers.view_sensitive, so there is
             * nothing here to unmask and nothing to reconstruct.
             */}
            {result.sensitiveVisible && result.phone
              ? result.phone
              : t("apsi.card.customerPhoneWithheld")}
          </span>
          <span className="text-caption tnum block text-text-muted">
            {t("apsi.card.customerOrders", { count: result.orderCount })}
          </span>
        </>
      );

    case "product":
      return (
        <>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-label min-w-0 flex-1 truncate text-text-primary">
              {result.name}
            </span>
            <span className="text-financial shrink-0 text-text-primary">
              {formatMoney(result.price)}
            </span>
          </span>
          <span className="text-body-sm block truncate text-text-secondary">
            {result.sku}
            {result.barcode ? ` · ${result.barcode}` : ""}
          </span>
          <span className="text-caption tnum block text-text-muted">
            {result.stock === null
              ? t("apsi.card.stockUnknown")
              : t("apsi.card.stockOnHand", { count: result.stock })}
          </span>
        </>
      );
  }
}
