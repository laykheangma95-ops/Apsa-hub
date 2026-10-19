/**
 * /app/payments/$id — one payment, and every action the member is allowed to
 * take on it.
 *
 * The id in the URL is only ever resolved inside the caller's own organization
 * (repo.findPaymentById filters on ctx.organizationId), so a payment id copied
 * from another business comes back as a plain "not found" — the same answer as
 * a made-up id, and nothing is mutated on the way there.
 *
 * ── THE THREE AXES STAY THREE ────────────────────────────────────────────────
 *
 * Settlement, verification and refunds are shown as three separate facts and
 * are never merged into one verdict:
 *
 *   - A partly refunded payment still reads `Paid`, with its refunds listed
 *     underneath. A fully refunded one reads `Refunded`. Neither is "unpaid".
 *   - Evidence is a document, never a settlement: attaching it moves nothing.
 *   - A COD payment record is a collection arrangement, never proof money
 *     arrived.
 *   - The order-level none/partial/full refund verdict comes from
 *     order_payment_totals (SQL, migration 040) — this screen never computes it.
 *
 * Nothing on this screen performs financial arithmetic. Every amount is
 * rendered exactly as the server sent it, with its own explicit currency, and
 * amounts in different currencies are never combined.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Landmark,
  RotateCcw,
  ShieldCheck,
  Undo2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionRow,
  AppHeader,
  DetailSkeleton,
  InlineAction,
  ScreenBleed,
  Section,
  SectionRow,
  SectionRows,
  Timeline,
  type TimelineItem,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import {
  PaymentMethodChip,
  PaymentReviewChip,
  PaymentStatusChip,
  PaymentVerificationChip,
} from "@/components/payments/PaymentStateChips";
import {
  PaymentRefundSheet,
  PaymentReverseSheet,
  PaymentVerifySheet,
} from "@/components/payments/PaymentActionSheets";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  getRealOrderSettlement,
  getRealPaymentDetail,
  refundRealPayment,
  reverseRealPayment,
  verifyRealPayment,
} from "@/lib/api";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import type { InitiatingPrincipal } from "@/lib/initiating-principal";
import {
  abandonPendingRefund,
  acknowledgeRefunds,
  beginRefund,
  readRefundIntent,
  refundSucceeded,
  type RefundIntentScope,
} from "@/lib/refund-intent";
import { ordersKeys } from "@/lib/orders-query";
import { evictShippingLabels } from "@/lib/fulfillment-query";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import {
  availableVerificationTargets,
  canRefundUiPayment,
  canReverseUiPayment,
  classifyPaymentError,
  isPaymentId,
  isRefundConfirmationRequired,
  isTerminalUiPaymentStatus,
  paymentErrorKey,
  paymentNeedsReview,
  refundEventsOf,
  refundedMinorOf,
  UI_VERIFICATION_TRANSITION_PERMISSIONS,
  type PaymentVerificationState,
  type UiPaymentDetail,
} from "@/lib/payments";

export const Route = createFileRoute("/app/payments/$id")({
  head: () => ({
    meta: [
      { title: "Payment — APSA" },
      {
        name: "description",
        content: "One payment: amount, settlement, verification, refunds and history.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PaymentDetailScreen,
});

const VERIFY_ICON: Record<PaymentVerificationState, LucideIcon> = {
  unverified: RotateCcw,
  staff_confirmed: UserCheck,
  manager_verified: ShieldCheck,
  bank_verified: Landmark,
  mismatch: AlertTriangle,
  duplicate_suspected: AlertTriangle,
};

/** Timeline dot tone per event type. Never the only signal — each entry is written out too. */
const EVENT_TONE: Record<string, TimelineItem["tone"]> = {
  created: "default",
  evidence_attached: "default",
  staff_confirmed: "success",
  manager_verified: "success",
  bank_verified: "success",
  verification_failed: "danger",
  correction: "warning",
  reversal: "danger",
  refund: "warning",
  duplicate_flagged: "warning",
};

/** What every action on this screen is started for: the payment shown, as the member shown. */
interface PaymentActionStart {
  paymentId: string;
  startedAs: InitiatingPrincipal;
}

/** One logical refund, as the merchant started it. */
interface RefundAttempt extends PaymentActionStart {
  amountMinor: number;
  reason: string;
  /** The refunded total on screen when it was started. */
  expectedRefundedMinor: number;
  /** The logical refund's durable key (src/lib/refund-intent.ts). */
  idempotencyKey: string;
  /** Every refund on this payment the merchant has seen. */
  acknowledgedRefundIds: string[];
  scope: RefundIntentScope;
}

/** One action tap: the screen's scope epoch and tap number at that moment. */
interface PaymentActionAttempt {
  epoch: number;
  attempt: number;
}

const actionScopeOf = ({ paymentId, startedAs }: PaymentActionStart) =>
  `${startedAs.userId}\u0000${startedAs.organizationId}\u0000${paymentId}`;

function PaymentDetailScreen() {
  const { id } = Route.useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Same identity rule as the list: cache keys are partitioned by user AND
   * organization, both from the server-derived route context, because
   * payments.view_provider_reference changes what the SERVER puts in
   * `reference` and `note` and two members of one organization can differ on it.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  const canReadPayments = identityOk && capabilities.can("payments.read");
  const canReconcile = identityOk && capabilities.canSensitive("payments.reconcile");
  const canReadOrders = identityOk && capabilities.can("orders.read");
  const canRefund = identityOk && capabilities.can("payments.refund");
  const canReverse = identityOk && capabilities.can("payments.reverse");

  const validId = isPaymentId(id);

  const paymentQuery = useQuery({
    queryKey: ["payments", userId, routeOrganizationId, "detail", id],
    queryFn: () => getRealPaymentDetail(id),
    enabled: canReadPayments && validId,
    retry: false,
  });

  const payment = paymentQuery.data;

  /*
   * Order settlement is a SEPARATE read against order_payment_totals, gated on
   * payments.reconcile server-side. It is the only authoritative source of the
   * order's none/partial/full refund verdict, and it is fetched only once the
   * payment itself resolved (its orderId is what identifies the order).
   */
  const settlementQuery = useQuery({
    queryKey: ["payments", userId, routeOrganizationId, "settlement", payment?.orderId ?? "none"],
    queryFn: () => getRealOrderSettlement(payment!.orderId),
    enabled: canReconcile && Boolean(payment?.orderId),
    retry: false,
  });

  const [verifyTarget, setVerifyTarget] = useState<PaymentVerificationState | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  /*
   * The server refused a new refund because the payment already has refunds
   * the merchant has not seen here (a retry after a reload, another tab,
   * another member): the sheet then shows them and asks for an explicit
   * decision instead of refunding again.
   */
  const [refundReview, setRefundReview] = useState(false);
  /** Where this screen's logical refunds are remembered — this member, this organization, this payment. */
  const refundScope: RefundIntentScope = {
    userId,
    organizationId: routeOrganizationId,
    paymentId: id,
  };
  const [reverseOpen, setReverseOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Everything a verification, refund or reversal makes stale for THIS
   * principal: every payments entry, the order this payment settles (its
   * payment/refund status is derived from settlement), and Home — whose
   * payment-review count and net-collected figure move with every one of
   * these actions. Previously only the payments entries were refreshed, so
   * Home kept showing a verified payment as review work.
   */
  function invalidatePayments() {
    void queryClient.invalidateQueries({
      queryKey: ["payments", userId, routeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ordersKeys.principal(userId, routeOrganizationId),
    });
    void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
    // The shipping label prints the payment decision (PAID / COD amount).
    evictShippingLabels(queryClient, userId, routeOrganizationId);
  }

  function handleActionError(err: unknown) {
    const kind = classifyPaymentError(err);
    if (kind === "unauthorized") {
      void navigate({ to: "/sign-in" });
      return;
    }
    const message = t(paymentErrorKey(kind));
    setActionError(message);
    notifyError(message);
  }

  /*
   * The member + organization this screen acts as. Each action hands it to its
   * mutation as a VARIABLE at the tap (CORRECTIONS.md, CORRECTION-004): the
   * request carries the principal it was started as, and the server refuses it
   * — writing nothing — if a member or organization switch lands before it is
   * handled. Never authorization; the server derives that itself.
   */
  const memberPrincipal = { userId, organizationId: routeOrganizationId };
  const start: PaymentActionStart = { paymentId: id, startedAs: memberPrincipal };

  /*
   * An action's ANSWER belongs to the attempt that asked for it — the member,
   * organization and payment it was tapped for, and that tap's place in this
   * screen's sequence — never to whatever the screen shows when it lands.
   * This screen stays mounted across a member or organization switch and
   * across a move to another payment, and TanStack hands a pending mutation
   * every later render's callbacks: written with this render's state, member
   * A's late refund success was announced to member B, closed B's sheet, and —
   * worst — marked A's pending refund done and its refund SEEN although A
   * never saw it, so A's identical retry got a new key, acknowledged that
   * refund, and refunded a second time.
   *
   * `epoch` moves on every committed change of member, organization or
   * payment, and on unmount (layout effects, in the same commit: no answer can
   * land in between); `attempt` moves on every tap. Only an answer whose epoch
   * and attempt are both still current is applied. Any other is written
   * nowhere, announces nothing and leaves the refund intent untouched — the
   * refund stays pending under its key, so the screen reports it as made once
   * it is shown again and the same refund replays — and only marks its
   * initiator's own entries stale.
   */
  const actionScope = actionScopeOf(start);
  const actionRef = useRef({ scope: actionScope, epoch: 0, attempt: 0 });

  /**
   * Called from onMutate, which TanStack runs synchronously inside mutate() —
   * at the tap, with that tap's variable. A variable that does not name the
   * member and payment this screen shows can never be current.
   */
  function beginActionAttempt(started: PaymentActionStart): PaymentActionAttempt {
    const current = actionRef.current;
    current.attempt += 1;
    const shown = actionScopeOf(started) === current.scope;
    return { epoch: shown ? current.epoch : -1, attempt: current.attempt };
  }
  function isCurrentActionAttempt(attempt: PaymentActionAttempt | undefined) {
    const current = actionRef.current;
    return attempt?.epoch === current.epoch && attempt.attempt === current.attempt;
  }
  /**
   * An answer that is not applied: nothing of whoever is shown is touched;
   * only what the action made stale for its INITIATOR is marked so, to be
   * re-read under the initiator's own authority if it is shown again.
   */
  function invalidatePaymentsOf({ startedAs }: PaymentActionStart) {
    const { userId: startedBy, organizationId: startedIn } = startedAs;
    void queryClient.invalidateQueries({ queryKey: ["payments", startedBy, startedIn] });
    void queryClient.invalidateQueries({ queryKey: ordersKeys.principal(startedBy, startedIn) });
    void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
    evictShippingLabels(queryClient, startedBy, startedIn);
  }

  const verifyMutation = useMutation({
    mutationFn: ({
      paymentId,
      to,
      reason,
      startedAs,
    }: PaymentActionStart & {
      to: PaymentVerificationState;
      reason: string | undefined;
    }) => verifyRealPayment(paymentId, to, startedAs, reason),
    onMutate: beginActionAttempt,
    onSuccess: (_detail, variables, attempt) => {
      if (!isCurrentActionAttempt(attempt)) return invalidatePaymentsOf(variables);
      setVerifyTarget(null);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t(`payments.actions.verify.${variables.to}.done`));
    },
    onError: (err, variables, attempt) => {
      if (!isCurrentActionAttempt(attempt)) return invalidatePaymentsOf(variables);
      handleActionError(err);
    },
  });

  const refundMutation = useMutation({
    mutationFn: (attempt: RefundAttempt) =>
      refundRealPayment(attempt.paymentId, attempt.startedAs, {
        amountMinor: attempt.amountMinor,
        reason: attempt.reason,
        expectedRefundedMinor: attempt.expectedRefundedMinor,
        idempotencyKey: attempt.idempotencyKey,
        acknowledgedRefundIds: attempt.acknowledgedRefundIds,
      }),
    onMutate: beginActionAttempt,
    onSuccess: (detail, attempt, tap) => {
      // Not seen by the member who started it (another member, organization
      // or payment is shown, the screen is gone, or a newer tap superseded
      // it): the refund stays pending under its key — never acknowledged here.
      if (!isCurrentActionAttempt(tap)) return invalidatePaymentsOf(attempt);
      // Accepted — made now or replayed: that logical refund is done, the
      // merchant has seen it succeed, and the next refund gets a new key.
      const made = refundEventsOf(detail).find(
        (event) => event.idempotencyKey === attempt.idempotencyKey,
      );
      refundSucceeded(attempt.scope, made?.id ?? null);
      setRefundReview(false);
      setRefundOpen(false);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t("payments.actions.refund.done"));
    },
    onError: (err, attempt, tap) => {
      // The key stays pending either way: an uncertain outcome is retried
      // under the same key (a replay if it committed).
      if (!isCurrentActionAttempt(tap)) return invalidatePaymentsOf(attempt);
      if (isRefundConfirmationRequired(err)) {
        // Nothing was written. Show the refunds already made, re-read.
        setActionError(null);
        setRefundReview(true);
        invalidatePayments();
        return;
      }
      handleActionError(err);
    },
  });

  /**
   * Submit one refund: the durable key of the logical refund the merchant is
   * making (a retry of the same amount and reason reuses it, even after a
   * reload), the refunded total on screen, and the refunds already seen.
   */
  function submitRefund(current: UiPaymentDetail, amountMinor: number, reason: string) {
    const pending = beginRefund(refundScope, amountMinor, reason);
    refundMutation.mutate({
      ...start,
      amountMinor,
      reason,
      expectedRefundedMinor: refundedMinorOf(current),
      idempotencyKey: pending.key,
      acknowledgedRefundIds: readRefundIntent(refundScope).acknowledged,
      scope: refundScope,
    });
  }

  const reverseMutation = useMutation({
    mutationFn: ({ paymentId, reason, startedAs }: PaymentActionStart & { reason: string }) =>
      reverseRealPayment(paymentId, startedAs, reason),
    onMutate: beginActionAttempt,
    onSuccess: (_detail, variables, attempt) => {
      if (!isCurrentActionAttempt(attempt)) return invalidatePaymentsOf(variables);
      setReverseOpen(false);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t("payments.actions.reverse.done"));
    },
    onError: (err, variables, attempt) => {
      if (!isCurrentActionAttempt(attempt)) return invalidatePaymentsOf(variables);
      handleActionError(err);
    },
  });

  /*
   * A change of member, organization or payment, committed: what was started,
   * typed or reported for the previous one is not the next one's. No pending or
   * failed action state, no error and no open sheet carries over — the sheets
   * are also keyed by this scope, so a typed amount or reason is gone in the
   * same render, whether or not the next screen first shows a skeleton — and
   * every answer still in flight is stale (see actionRef). A refund's replay
   * identity is not in any of this: it lives in the refund intent, scoped to
   * its own member, organization and payment, and is still there when that
   * member comes back to that payment.
   */
  const { reset: resetVerify } = verifyMutation;
  const { reset: resetRefund } = refundMutation;
  const { reset: resetReverse } = reverseMutation;
  useLayoutEffect(() => {
    const current = actionRef.current;
    if (current.scope === actionScope) return;
    current.scope = actionScope;
    current.epoch += 1;
    resetVerify();
    resetRefund();
    resetReverse();
    setVerifyTarget(null);
    setRefundOpen(false);
    setRefundReview(false);
    setReverseOpen(false);
    setActionError(null);
  }, [actionScope, resetVerify, resetRefund, resetReverse]);
  useLayoutEffect(() => {
    const current = actionRef.current;
    return () => {
      // Unmounted: whatever is still in flight has no screen left to update.
      current.epoch += 1;
    };
  }, []);

  const queryErrorKind = paymentQuery.isError ? classifyPaymentError(paymentQuery.error) : null;

  useEffect(() => {
    if (queryErrorKind === "unauthorized") void navigate({ to: "/sign-in" });
  }, [queryErrorKind, navigate]);

  const header = (
    <AppHeader
      title={t("payments.detail.title")}
      onBack={() => void navigate({ to: "/app/payments" })}
    />
  );

  function shell(children: React.ReactNode) {
    return (
      <ScreenBleed surface="raised">
        {header}
        <main className="mx-auto flex w-full max-w-[var(--screen-max)] flex-col gap-3 px-4 pt-3 pb-8 lg:max-w-[var(--screen-max-wide)]">
          {children}
        </main>
      </ScreenBleed>
    );
  }

  if (!canReadPayments) return shell(<CapabilityDeniedState capabilities={capabilities} />);

  // A hand-typed or stale URL gets an honest "not found" rather than a request
  // the server's UUID validator would reject anyway. Not a security check —
  // an id that passes is still resolved only inside the caller's own org.
  if (!validId) {
    return shell(
      <OperationalState
        title={t("payments.detail.notFound.title")}
        body={t("payments.detail.notFound.body")}
      />,
    );
  }

  if (queryErrorKind === "unauthorized") return null; // redirecting

  if (queryErrorKind === "not_found") {
    return shell(
      <OperationalState
        title={t("payments.detail.notFound.title")}
        body={t("payments.detail.notFound.body")}
      />,
    );
  }

  if (queryErrorKind === "forbidden") {
    return shell(
      <OperationalState
        tone="danger"
        title={t("payments.list.forbidden.title")}
        body={t("payments.list.forbidden.body")}
      />,
    );
  }

  if (queryErrorKind) {
    return shell(
      <OperationalState
        tone="danger"
        title={t("payments.detail.error.title")}
        body={t("payments.detail.error.body")}
        onRetry={() => void paymentQuery.refetch()}
      />,
    );
  }

  if (!payment) return shell(<DetailSkeleton />);

  const refunds = refundEventsOf(payment);
  // A refund this screen started, whose response was lost, that the server
  // did commit (recognised by its own key — after a reload too).
  const pendingRefund = readRefundIntent(refundScope).pending;
  const recoveredRefund = pendingRefund
    ? (refunds.find((event) => event.idempotencyKey === pendingRefund.key) ?? null)
    : null;
  const frozen = isTerminalUiPaymentStatus(payment.status);
  const verificationTargets = availableVerificationTargets(payment).filter((target) =>
    capabilities.can(UI_VERIFICATION_TRANSITION_PERMISSIONS[target]),
  );
  const showRefund = canRefund && canRefundUiPayment(payment);
  const showReverse = canReverse && canReverseUiPayment(payment);
  const hasAnyAction = verificationTargets.length > 0 || showRefund || showReverse;

  const settlement = settlementQuery.data;
  const pending = verifyMutation.isPending || refundMutation.isPending || reverseMutation.isPending;

  /**
   * One ledger event as a history line. The amount and the reason are two
   * separate facts, so they are joined into one detail line rather than one
   * silently replacing the other. `reason` arrives already redacted by the
   * server for a caller without payments.view_provider_reference.
   */
  function toTimelineItem(event: UiPaymentDetail["events"][number]): TimelineItem {
    const parts = [
      event.amount ? formatMoney(event.amount) : null,
      event.reason ? event.reason : null,
    ].filter((part): part is string => part !== null);

    return {
      id: event.id,
      title: t(`payments.history.event.${event.eventType}`),
      ...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
      meta: fullTimestamp(event.createdAt),
      tone: EVENT_TONE[event.eventType] ?? "default",
    };
  }

  return (
    <ScreenBleed surface="raised">
      {header}

      <main className="mx-auto flex w-full max-w-[var(--screen-max)] flex-col gap-4 px-4 pt-3 pb-10 lg:max-w-[var(--screen-max-wide)]">
        {/* ── The one thing to read first: how much, in which currency ── */}
        <section className="elevation-1 rounded-2xl border border-border-default bg-surface-primary px-4 py-4">
          <p className="text-caption tnum text-text-muted">
            {t("payments.detail.recordedAt", { at: fullTimestamp(payment.createdAt) })}
          </p>
          <p className="text-h2 tnum mt-0.5 text-text-primary">{formatMoney(payment.amount)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <PaymentStatusChip status={payment.status} size="md" />
            <PaymentVerificationChip state={payment.verificationState} />
            <PaymentMethodChip method={payment.method} />
            {paymentNeedsReview(payment) ? <PaymentReviewChip /> : null}
          </div>
          {/*
           * The two axes are spelled out in words directly under the chips, so
           * "Paid · Needs review" can never be read as one combined verdict.
           */}
          <dl className="mt-3 flex flex-col gap-1">
            <div className="flex min-w-0 flex-wrap gap-x-2">
              <dt className="text-caption text-text-muted">{t("payments.status.label")}</dt>
              <dd className="text-caption text-text-secondary">{t("payments.status.help")}</dd>
            </div>
            <div className="flex min-w-0 flex-wrap gap-x-2">
              <dt className="text-caption text-text-muted">{t("payments.verification.label")}</dt>
              <dd className="text-caption text-text-secondary">
                {t("payments.verification.help")}
              </dd>
            </div>
          </dl>
          {payment.method === "cod" ? (
            <p className="text-caption mt-2 text-text-secondary" role="note">
              {t("payments.method.codNote")}
            </p>
          ) : null}
        </section>

        {/* ── Order ── */}
        <Section title={t("payments.detail.order.title")}>
          <SectionRows>
            <SectionRow
              label={t("payments.detail.order.id")}
              value={
                canReadOrders ? (
                  <InlineAction
                    numeric
                    onClick={() =>
                      void navigate({ to: "/app/orders/$id", params: { id: payment.orderId } })
                    }
                  >
                    {t("payments.detail.order.view")}
                  </InlineAction>
                ) : (
                  <span className="text-caption text-text-muted">
                    {t("payments.detail.order.noAccess")}
                  </span>
                )
              }
            />
          </SectionRows>
          <p className="text-caption mt-2 text-text-secondary">{t("payments.detail.order.note")}</p>
        </Section>

        {/* ── Order settlement: the authoritative refund verdict, from SQL ── */}
        {canReconcile ? (
          <Section title={t("payments.settlement.title")}>
            {settlementQuery.isLoading ? (
              <p className="text-body-sm text-text-secondary">{t("common.loading")}</p>
            ) : settlementQuery.isError || !settlement ? (
              <p className="text-body-sm text-text-secondary" role="status">
                {t("payments.settlement.unavailable")}
              </p>
            ) : (
              <>
                <SectionRows>
                  <SectionRow
                    label={t("payments.settlement.total")}
                    value={
                      <span className="tnum text-text-primary">
                        {formatMoney(settlement.total)}
                      </span>
                    }
                  />
                  <SectionRow
                    label={t("payments.settlement.received")}
                    value={
                      <span className="tnum text-text-primary">
                        {formatMoney(settlement.received)}
                      </span>
                    }
                  />
                  <SectionRow
                    label={t("payments.settlement.refunded")}
                    value={
                      <span className="tnum text-text-primary">
                        {formatMoney(settlement.refunded)}
                      </span>
                    }
                  />
                  <SectionRow
                    label={t("payments.settlement.net")}
                    value={
                      <span className="tnum text-text-primary">{formatMoney(settlement.net)}</span>
                    }
                  />
                  <SectionRow
                    label={t("payments.settlement.paymentStatus")}
                    value={t(`payments.settlement.orderPaymentStatus.${settlement.paymentStatus}`)}
                  />
                  <SectionRow
                    label={t("payments.settlement.refundStatus")}
                    value={t(`payments.settlement.refundStatusValue.${settlement.refundStatus}`)}
                  />
                </SectionRows>
                {settlement.overpaid && settlement.overpaidAmount ? (
                  <p
                    className="text-caption mt-2 flex items-start gap-1.5 text-status-warning-text"
                    role="status"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>
                      {t("payments.settlement.overpaid", {
                        amount: formatMoney(settlement.overpaidAmount),
                      })}
                    </span>
                  </p>
                ) : null}
                <p className="text-caption mt-2 text-text-secondary">
                  {t("payments.settlement.note")}
                </p>
              </>
            )}
          </Section>
        ) : null}

        {/* ── Refunds on THIS payment, straight from the immutable ledger ── */}
        <Section title={t("payments.refunds.title")}>
          {recoveredRefund?.amount ? (
            <p className="text-body-sm mb-2 text-text-primary" role="status">
              {t("payments.actions.refund.recovered", {
                amount: formatMoney(recoveredRefund.amount),
                time: fullTimestamp(recoveredRefund.createdAt),
              })}
            </p>
          ) : null}
          {refunds.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("payments.refunds.empty")}</p>
          ) : (
            <SectionRows>
              {refunds.map((event) => (
                <SectionRow
                  key={event.id}
                  label={
                    <span className="text-caption tnum text-text-muted">
                      {fullTimestamp(event.createdAt)}
                    </span>
                  }
                  value={
                    <span className="tnum text-text-primary">
                      {event.amount ? formatMoney(event.amount) : t("payments.refunds.noAmount")}
                    </span>
                  }
                />
              ))}
            </SectionRows>
          )}
          {/*
           * No total is shown here on purpose: summing the ledger in the
           * browser would be recomputing a financial fact. The authoritative
           * refunded figure is the settlement panel's, derived in SQL.
           */}
          <p className="text-caption mt-2 text-text-secondary">{t("payments.refunds.note")}</p>
        </Section>

        {/* ── Reference / note, only ever as the server sent them ── */}
        {payment.reference || payment.note ? (
          <Section title={t("payments.detail.details")}>
            <SectionRows>
              {payment.reference ? (
                <SectionRow
                  label={t("payments.detail.reference")}
                  value={<span className="tnum break-all">{payment.reference}</span>}
                />
              ) : null}
              {payment.note ? (
                <SectionRow label={t("payments.detail.note")} value={payment.note} />
              ) : null}
            </SectionRows>
          </Section>
        ) : null}

        {/* ── Evidence: a document, never a settlement ── */}
        <Section title={t("payments.evidence.title")}>
          {payment.evidence.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("payments.evidence.empty")}</p>
          ) : (
            <SectionRows>
              {payment.evidence.map((item) => (
                <SectionRow
                  key={item.id}
                  label={t(`payments.evidence.type.${item.evidenceType}`)}
                  value={
                    <span className="text-caption tnum text-text-secondary">
                      {fullTimestamp(item.createdAt)}
                    </span>
                  }
                />
              ))}
            </SectionRows>
          )}
          <p className="text-caption mt-2 text-text-secondary" role="note">
            {t("payments.evidence.note")}
          </p>
        </Section>

        {/* ── History: the immutable event ledger, in business language ── */}
        <Section title={t("payments.history.title")}>
          {payment.events.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("payments.history.empty")}</p>
          ) : (
            <Timeline items={payment.events.map(toTimelineItem)} />
          )}
        </Section>

        {/* ── Actions ── */}
        <Section title={t("payments.actions.title")}>
          {frozen ? (
            <p className="text-body-sm text-text-secondary" role="status">
              {t("payments.actions.frozen", { status: t(`payments.status.${payment.status}`) })}
            </p>
          ) : null}

          {!frozen && !hasAnyAction ? (
            <p className="text-body-sm text-text-secondary" role="status">
              {t("payments.actions.readOnly")}
            </p>
          ) : null}

          {hasAnyAction ? (
            <div className="flex flex-col gap-2">
              {verificationTargets.map((target) => {
                const Icon = VERIFY_ICON[target];
                return (
                  <ActionRow
                    key={target}
                    icon={Icon}
                    label={t(`payments.actions.verify.${target}.label`)}
                    description={t(`payments.actions.verify.${target}.body`)}
                    emphasis={target === "staff_confirmed"}
                    disabled={pending}
                    onClick={() => {
                      setActionError(null);
                      setVerifyTarget(target);
                    }}
                  />
                );
              })}

              {showRefund ? (
                <ActionRow
                  icon={RotateCcw}
                  label={t("payments.actions.refund.label")}
                  description={t("payments.actions.refund.rowBody")}
                  tone="danger"
                  disabled={pending}
                  onClick={() => {
                    setActionError(null);
                    setRefundOpen(true);
                  }}
                />
              ) : null}

              {showReverse ? (
                <ActionRow
                  icon={Undo2}
                  label={t("payments.actions.reverse.label")}
                  description={t("payments.actions.reverse.rowBody")}
                  tone="danger"
                  disabled={pending}
                  onClick={() => {
                    setActionError(null);
                    setReverseOpen(true);
                  }}
                />
              ) : null}
            </div>
          ) : null}

          <p className="text-caption mt-3 text-text-secondary">
            {t("payments.actions.serverNote")}
          </p>
        </Section>
      </main>

      <PaymentVerifySheet
        // Bound to the member, organization and payment: a typed reason never
        // survives into another principal's screen or onto another payment.
        // (Sibling keys must differ: the other two sheets are keyed by scope too.)
        key={`verify:${actionScope}`}
        open={verifyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVerifyTarget(null);
        }}
        target={verifyTarget}
        pending={verifyMutation.isPending}
        error={actionError}
        onConfirm={(reason) => {
          if (!verifyTarget) return;
          verifyMutation.mutate({ ...start, to: verifyTarget, reason });
        }}
      />

      <PaymentRefundSheet
        key={`refund:${actionScope}`}
        open={refundOpen}
        onOpenChange={(open) => {
          setRefundOpen(open);
          if (!open) setRefundReview(false);
        }}
        principal={payment.amount}
        pending={refundMutation.isPending}
        error={actionError}
        review={
          refundReview
            ? refunds.map((event) => ({
                id: event.id,
                amount: event.amount,
                createdAt: event.createdAt,
                byYou: event.actorUserId === userId,
              }))
            : null
        }
        onConfirm={(amountMinor, reason) => submitRefund(payment, amountMinor, reason)}
        onConfirmBeyond={(amountMinor, reason) => {
          // An explicit decision, after seeing every refund listed: refund more.
          acknowledgeRefunds(
            refundScope,
            refunds.map((event) => event.id),
          );
          submitRefund(payment, amountMinor, reason);
        }}
        onDecline={() => {
          // The refund already made was the one intended: nothing more to do.
          abandonPendingRefund(refundScope);
          setRefundReview(false);
          setRefundOpen(false);
        }}
      />

      <PaymentReverseSheet
        key={`reverse:${actionScope}`}
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        pending={reverseMutation.isPending}
        error={actionError}
        onConfirm={(reason) => reverseMutation.mutate({ ...start, reason })}
      />
    </ScreenBleed>
  );
}
