import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Search, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useNavSignals } from "@/hooks/use-nav-signals";
import { useTabState } from "@/hooks/use-tab-memory";
import { homeQueryKey } from "@/lib/home-query";
import {
  getHomeSummary,
  getProducts,
  listRealCustomers,
  listRealOrders,
  listRealPayments,
  mapOrderCustomerOptionToUi,
} from "@/lib/api";
import { runApsiSearch, type ApsiCommand, type ApsiEntityResult } from "@/lib/apsi-search";
import { cn } from "@/lib/utils";
import type { ApsiEmotion } from "./mascot";
import { Apsi } from "./mascot";
import { BottomSheet } from "./BottomSheet";
import { EmptyState } from "./EmptyState";
import { StatusChip } from "./StatusChip";

/**
 * Apsi's state of mind, and what earns each one.
 *
 * Every state here is a fact about the search, not a mood we picked to look
 * friendly: Apsi is only "thinking" while a read is actually in flight, only
 * "success" on a single unambiguous hit, and only "warning" when a read really
 * failed. A mascot that celebrates a search it did not run is the fastest way
 * to teach a merchant to stop believing the app.
 */
export type ApsiSearchState = "idle" | "thinking" | "found" | "success" | "warning" | "empty";

const STATE_EMOTION: Record<ApsiSearchState, ApsiEmotion> = {
  idle: "default",
  thinking: "thinking",
  found: "winking",
  success: "success",
  warning: "supportive",
  empty: "sleepy",
};

interface ApsiSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The centre control's sheet: one box that searches everything and goes there.
 *
 * A sheet and not a route, deliberately. Apsi is something a merchant does
 * *from* where they already are — mid-conversation, mid-sale — so the screen
 * behind stays put and dismissing brings it straight back, with no entry added
 * to their history to back out of later.
 */
export function ApsiSheet({ open, onOpenChange }: ApsiSheetProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const capabilities = useCapabilities();
  /*
   * Apsi searches one organization's records, so every cache entry it creates
   * is keyed by the principal that is allowed to see them. One browser tab can
   * serve two people in a day — sign out, sign in, switch organization — and a
   * customer list must never be read back under the wrong one.
   */
  const { principal } = useNavSignals();
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * The query survives closing the sheet: a merchant who taps away to check
   * something and comes back has not retyped an order code on a phone keyboard
   * for nothing. Stored against Home's tab, which is the one tab Apsi is
   * always reachable from.
   */
  const [query, setQuery] = useTabState("home", "apsi-query", "");

  const canReadOrders = capabilities.can("orders.read");
  const canReadCustomers = capabilities.can("customers.read");
  const canReadProducts = capabilities.can("products.read");
  const canReadPayments = capabilities.can("payments.read");

  /*
   * Loaded when the sheet opens, not on every keystroke. These are the same
   * bounded list reads the corresponding screens already make, so the search
   * runs against data the member is independently authorized to see — Apsi
   * introduces no read of its own and no new server surface.
   *
   * `retry: 1`, against the default three-with-backoff, is the whole reason
   * the offline state is reachable: a merchant on a dead connection waited
   * eight seconds watching skeleton rows before anything told them what was
   * wrong. One quick retry, then say so. A skeleton that never resolves is
   * the spinner wall it was meant to replace.
   */
  const searchQueryOptions = { enabled: open, staleTime: 60_000, retry: 1 } as const;
  const ordersQuery = useQuery({
    queryKey: ["apsi", principal.userId, principal.organizationId, "orders"],
    queryFn: listRealOrders,
    ...searchQueryOptions,
    enabled: open && canReadOrders,
  });
  const customersQuery = useQuery({
    queryKey: ["apsi", principal.userId, principal.organizationId, "customers"],
    queryFn: async () => (await listRealCustomers()).map(mapOrderCustomerOptionToUi),
    ...searchQueryOptions,
    enabled: open && canReadCustomers,
  });
  const productsQuery = useQuery({
    queryKey: ["apsi", principal.userId, principal.organizationId, "products"],
    queryFn: getProducts,
    ...searchQueryOptions,
    enabled: open && canReadProducts,
  });
  const paymentsQuery = useQuery({
    queryKey: ["apsi", principal.userId, principal.organizationId, "payments"],
    queryFn: () => listRealPayments({ limit: 30 }),
    ...searchQueryOptions,
    enabled: open && canReadPayments,
  });
  /*
   * Deliberately the same cache entry Home and the bar's attention dot use, so
   * the counts behind Apsi's suggestions are the counts on Home — and opening
   * Apsi costs no request at all once Home has been seen.
   */
  const homeQuery = useQuery({
    queryKey: homeQueryKey(principal.userId, principal.organizationId, "today"),
    queryFn: () => getHomeSummary("today"),
    ...searchQueryOptions,
    enabled: open && capabilities.state === "ready",
  });

  const orders = useMemo(() => ordersQuery.data ?? [], [ordersQuery.data]);
  const customers = useMemo(() => customersQuery.data ?? [], [customersQuery.data]);
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const payments = useMemo(() => paymentsQuery.data?.items ?? [], [paymentsQuery.data]);

  /*
   * Suggestions are made of the merchant's own data, and each one appears only
   * when the thing it points at exists. No placeholder order number, no
   * invented customer: an empty business gets an empty first frame, which is
   * the truth about an empty business.
   */
  const commands = useMemo<ApsiCommand[]>(() => {
    const list: ApsiCommand[] = [];
    const keywords = (key: string): string[] =>
      t(key)
        .split(",")
        .map((word) => word.trim().toLowerCase())
        .filter(Boolean);

    const unpaidCount = orders.filter(
      (order) => order.paymentStatus === "unpaid" || order.paymentStatus === "pending_payment",
    ).length;
    if (canReadOrders && unpaidCount > 0) {
      list.push({
        id: "unpaid-orders",
        label: t("apsi.commands.unpaidOrders"),
        keywords: keywords("apsi.keywords.unpaidOrders"),
        href: "/app/orders?payment=unpaid",
        count: unpaidCount,
      });
    }

    const latestOrder = orders[0];
    if (canReadOrders && latestOrder) {
      list.push({
        id: "recent-order",
        label: t("apsi.commands.whereIsOrder", { code: latestOrder.code }),
        keywords: keywords("apsi.keywords.whereIsOrder"),
        href: `/app/orders/${latestOrder.id}`,
      });
    }

    const outOfStock =
      homeQuery.data?.inventory.status === "available"
        ? homeQuery.data.inventory.data.outOfStockVariantCount
        : 0;
    if (canReadProducts && outOfStock > 0) {
      list.push({
        id: "low-stock",
        label: t("apsi.commands.lowStock"),
        keywords: keywords("apsi.keywords.lowStock"),
        href: "/app/products",
        count: outOfStock,
      });
    }

    const reviewCount =
      homeQuery.data?.payments.status === "available"
        ? homeQuery.data.payments.data.needsReviewCount
        : 0;
    if (canReadPayments && reviewCount > 0) {
      list.push({
        id: "payments-to-review",
        label: t("apsi.commands.paymentsToReview"),
        keywords: keywords("apsi.keywords.paymentsToReview"),
        href: "/app/payments?filter=verification%3Aunverified",
        count: reviewCount,
      });
    }

    const firstCustomer = customers[0];
    if (canReadCustomers && firstCustomer) {
      const name = firstCustomer.nameKm || firstCustomer.nameEn;
      list.push({
        id: "recent-customer",
        label: t("apsi.commands.customer", { name }),
        keywords: keywords("apsi.keywords.customer"),
        href: `/app/customers/${firstCustomer.id}`,
      });
    }

    return list;
  }, [
    t,
    orders,
    customers,
    homeQuery.data,
    canReadOrders,
    canReadProducts,
    canReadPayments,
    canReadCustomers,
  ]);

  const results = useMemo(
    () => runApsiSearch({ query, commands, orders, customers, products, payments }),
    [query, commands, orders, customers, products, payments],
  );

  const loading =
    ordersQuery.isFetching ||
    customersQuery.isFetching ||
    productsQuery.isFetching ||
    paymentsQuery.isFetching;
  const failed =
    ordersQuery.isError || customersQuery.isError || productsQuery.isError || paymentsQuery.isError;
  /*
   * A failed read is only an Apsi failure when it left Apsi with nothing.
   * Offline with a warm cache still answers — which is the whole reason there
   * is no spinner wall here.
   */
  const hasData =
    orders.length > 0 || customers.length > 0 || products.length > 0 || payments.length > 0;

  const total = results.commands.length + results.entities.length;
  const state: ApsiSearchState =
    failed && !hasData
      ? "warning"
      : query.trim() === ""
        ? loading && !hasData
          ? "thinking"
          : "idle"
        : loading && !hasData
          ? "thinking"
          : total === 0
            ? "empty"
            : total === 1
              ? "success"
              : "found";

  /*
   * Focus the field as the sheet settles. iOS will not raise the keyboard for
   * a focus call this far from the original tap, so on iPhone the field is
   * focused and the merchant taps once to type — the same as every native
   * search sheet on that platform. Everywhere else the keyboard comes up with
   * the sheet.
   */
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 140);
    return () => clearTimeout(timer);
  }, [open]);

  function go(href: string) {
    onOpenChange(false);
    void router.navigate({ to: href });
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("apsi.title")}
      description={t("apsi.lead")}
      snap="tall"
      className="h-[85dvh]"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className="relative shrink-0">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            ref={inputRef}
            type="search"
            autoFocus
            enterKeyHint="search"
            className="h-12 pl-9"
            value={query}
            aria-label={t("apsi.placeholder")}
            placeholder={t("apsi.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {state === "warning" ? (
          <EmptyState
            emotion={STATE_EMOTION.warning}
            title={t("apsi.offline.title")}
            body={t("apsi.offline.body")}
            action={
              <button
                type="button"
                onClick={() => {
                  void ordersQuery.refetch();
                  void customersQuery.refetch();
                  void productsQuery.refetch();
                  void paymentsQuery.refetch();
                }}
                className="press tap-target text-label inline-flex items-center gap-2 rounded-full border border-border-default px-4 text-action-primary"
              >
                <WifiOff className="size-4" aria-hidden />
                {t("apsi.offline.retry")}
              </button>
            }
          />
        ) : null}

        {state === "thinking" ? <ApsiSkeleton /> : null}

        {state === "idle" ? (
          <SuggestionList commands={commands} onPick={go} emptyLabel={t("apsi.noSuggestions")} />
        ) : null}

        {state === "empty" ? (
          <EmptyState
            emotion={STATE_EMOTION.empty}
            title={t("apsi.empty.title")}
            body={t("apsi.empty.body")}
          />
        ) : null}

        {state === "found" || state === "success" ? (
          <div className="list-enter flex min-h-0 flex-col gap-4">
            <p className="text-caption flex items-center gap-2 text-text-secondary">
              <Apsi emotion={STATE_EMOTION[state]} size="xs" />
              {t(state === "success" ? "apsi.foundOne" : "apsi.foundMany", { count: total })}
            </p>

            {results.commands.length > 0 ? (
              <SuggestionList commands={results.commands} onPick={go} />
            ) : null}

            {results.entities.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {results.entities.map((entity) => (
                  <li key={`${entity.kind}-${entity.id}`}>
                    <EntityRow entity={entity} onPick={go} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function SuggestionList({
  commands,
  onPick,
  emptyLabel,
}: {
  commands: readonly ApsiCommand[];
  onPick: (href: string) => void;
  emptyLabel?: string;
}) {
  const { t } = useTranslation();

  if (commands.length === 0) {
    return emptyLabel ? (
      <p className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary">
        {emptyLabel}
      </p>
    ) : null;
  }

  return (
    <div>
      <h3 className="text-label px-1 pb-2 text-text-muted">{t("apsi.suggestions")}</h3>
      {/*
       * Chips, not rows: each one is a whole command, not a record.
       *
       * Deliberately not the shared <Chip>, which is a fixed 40px tall — right
       * for a one-word filter, wrong here, because a Khmer command label
       * ("បង្ហាញការបញ្ជាទិញមិនទាន់បង់ប្រាក់") wraps to two lines and a fixed height
       * would cut it in half. These wrap instead, per CLAUDE.md's rule that
       * Khmer is never clipped.
       */}
      <div className="flex flex-wrap gap-2">
        {commands.slice(0, 4).map((command) => (
          <button
            key={command.id}
            type="button"
            onClick={() => onPick(command.href)}
            className="press text-label inline-flex max-w-full items-center gap-2 rounded-full border border-action-primary-border bg-action-primary-soft px-3.5 py-2 text-left text-status-info-text"
          >
            <span className="chip-text">{command.label}</span>
            {command.count !== undefined ? (
              <span className="text-caption tnum rounded-full bg-action-primary px-1.5 text-text-on-action">
                {command.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function EntityRow({
  entity,
  onPick,
}: {
  entity: ApsiEntityResult;
  onPick: (href: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={() => onPick(entity.href)}
      className="press flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-4 py-3 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="text-caption block text-text-muted">{t(`apsi.kind.${entity.kind}`)}</span>
        <span className="text-body tnum mt-0.5 block truncate text-text-primary">
          {entity.primary}
        </span>
        {entity.secondary ? (
          <span className="text-caption mt-0.5 block truncate text-text-secondary">
            {entity.secondary}
          </span>
        ) : null}
        {entity.statuses.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {entity.statuses.map((status) => (
              <StatusChip key={status} status={status} />
            ))}
          </span>
        ) : null}
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-text-muted" aria-hidden />
    </button>
  );
}

/**
 * A skeleton shaped like the answer, not a spinner.
 *
 * Three rows at the height a result row actually is, so when the data lands
 * nothing moves — the grey shapes become text in place.
 */
function ApsiSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className={cn("h-[72px] animate-pulse rounded-2xl bg-surface-secondary")} />
      ))}
    </div>
  );
}
