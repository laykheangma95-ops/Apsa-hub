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
import { useEffect, useRef, useState } from "react";
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
import { notifyError, notifySuccess } from "@/lib/feedback";
import { fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import {
  availableVerificationTargets,
  canRefundUiPayment,
  canReverseUiPayment,
  classifyPaymentError,
  governingPaymentDenial,
  isPaymentId,
  isTerminalUiPaymentStatus,
  paymentErrorKey,
  paymentNeedsReview,
  refundEventsOf,
  resolveRefundIntent,
  UI_VERIFICATION_TRANSITION_PERMISSIONS,
  visiblePaymentRecord,
  type PaymentVerificationState,
  type RefundIntent,
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

  const queryErrorKind = paymentQuery.isError ? classifyPaymentError(paymentQuery.error) : null;

  /*
   * The cached payment is read through visiblePaymentRecord, never off
   * paymentQuery.data directly, so an explicit 403/401 on a refresh empties
   * this screen on the very next render rather than leaving the previous
   * answer on display. The forbidden branch below also returns early, but
   * that is statement order and statement order is not a guarantee — this is
   * the gate, and src/tests/payments-operations-ui.test.ts asserts no payment
   * surface reads around it. Transient failures are untouched: only forbidden
   * and unauthorized mask (see paymentAccessDenied).
   */
  const payment = visiblePaymentRecord(paymentQuery.data, queryErrorKind);

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
   * The UNRESOLVED refund decision this screen is carrying, and the
   * idempotency key every attempt at it must reuse.
   *
   * Held in a ref rather than state on purpose: it is read and written from
   * inside mutationFn, where a state write would schedule a pointless render,
   * and it has to survive every re-render a failed attempt causes — including
   * the ones from closing and reopening the refund sheet.
   *
   * IT IS CLEARED IN EXACTLY ONE PLACE: a confirmed server result. Not when
   * the sheet closes, and not when it reopens. A refund that committed in
   * PostgreSQL and lost its response leaves the merchant with a sheet they
   * will very often close and reopen before trying again, and minting a new
   * key on that reopen would refund a customer twice — the defect this ref
   * exists to prevent. An intent with no confirmed outcome therefore
   * outlives the sheet, and only resolveRefundIntent's own terms check
   * (payment, integer minor amount, normalised reason) decides whether the
   * next press inherits its key or starts a new decision.
   *
   * Its lifetime is this payment-detail screen: a plain component ref, never
   * persisted, never shared between payments (resolveRefundIntent rejects a
   * held intent whose paymentId differs) and never readable by another
   * principal or another tab.
   */
  const refundIntentRef = useRef<RefundIntent | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /** Every payments cache entry for THIS principal, and nothing else. */
  function invalidatePayments() {
    void queryClient.invalidateQueries({
      queryKey: ["payments", userId, routeOrganizationId],
    });
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

  const verifyMutation = useMutation({
    mutationFn: ({ to, reason }: { to: PaymentVerificationState; reason: string | undefined }) =>
      verifyRealPayment(id, to, reason),
    onSuccess: (_detail, variables) => {
      setVerifyTarget(null);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t(`payments.actions.verify.${variables.to}.done`));
    },
    onError: handleActionError,
  });

  const refundMutation = useMutation({
    mutationFn: ({ amountMinor, reason }: { amountMinor: number; reason: string }) => {
      /*
       * Resolve BEFORE the request and store it back, so a retry of this same
       * decision — the merchant pressing confirm again after a request that
       * may or may not have committed — sends the identical key and is
       * replayed by refund_payment_v1 instead of refunding a second time.
       */
      const intent = resolveRefundIntent(refundIntentRef.current, {
        paymentId: id,
        amountMinor,
        reason,
      });
      refundIntentRef.current = intent;
      return refundRealPayment(id, amountMinor, reason, intent.idempotencyKey);
    },
    onSuccess: () => {
      /*
       * The only place the intent is dropped. The server has confirmed an
       * outcome for this decision — a fresh refund or a replay of the one it
       * already held — so the key has done its job and the NEXT refund, even
       * one repeating these exact terms, is a separate refund that must mint
       * a separate key.
       */
      refundIntentRef.current = null;
      setRefundOpen(false);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t("payments.actions.refund.done"));
    },
    /*
     * Deliberately NOT cleared on error, and deliberately not cleared by the
     * sheet closing afterwards. A failure may be a lost response over a
     * refund that committed, and only the retained key makes the retry a
     * replay. A failure the server actually decided (invalid amount, wrong
     * state, denied) wrote no refund event, so its key was never bound and
     * reusing it costs nothing either way.
     */
    onError: handleActionError,
  });

  const reverseMutation = useMutation({
    mutationFn: (reason: string) => reverseRealPayment(id, reason),
    onSuccess: () => {
      setReverseOpen(false);
      setActionError(null);
      invalidatePayments();
      notifySuccess(t("payments.actions.reverse.done"));
    },
    onError: handleActionError,
  });

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
  const frozen = isTerminalUiPaymentStatus(payment.status);
  const verificationTargets = availableVerificationTargets(payment).filter((target) =>
    capabilities.can(UI_VERIFICATION_TRANSITION_PERMISSIONS[target]),
  );
  const showRefund = canRefund && canRefundUiPayment(payment);
  const showReverse = canReverse && canReverseUiPayment(payment);
  const hasAnyAction = verificationTargets.length > 0 || showRefund || showReverse;

  /*
   * Settlement figures are payment amounts too, and they pass the same gate
   * under the same rule as the list's reconciliation band: a 403 on the
   * settlement refresh drops the cached received/refunded/net numbers, AND a
   * 403 on the payment read governs them as well, so a settlement response
   * held from before a revocation cannot outlive the payment it describes.
   */
  const settlement = visiblePaymentRecord(
    settlementQuery.data,
    governingPaymentDenial(
      queryErrorKind,
      settlementQuery.isError ? classifyPaymentError(settlementQuery.error) : null,
    ),
  );
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
                  disabled={pending}
                  onClick={() => {
                    setActionError(null);
                    /*
                     * No intent reset here. Reopening the sheet is how a
                     * merchant retries after a failure they could not read
                     * the outcome of, so an unresolved intent must survive it
                     * and keep its key; a genuinely new refund is the one
                     * that follows a CONFIRMED result, and onSuccess has
                     * already cleared the intent by then.
                     */
                    setRefundOpen(true);
                  }}
                />
              ) : null}

              {showReverse ? (
                <ActionRow
                  icon={Undo2}
                  label={t("payments.actions.reverse.label")}
                  description={t("payments.actions.reverse.rowBody")}
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
        open={verifyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVerifyTarget(null);
        }}
        target={verifyTarget}
        pending={verifyMutation.isPending}
        error={actionError}
        onConfirm={(reason) => {
          if (!verifyTarget) return;
          verifyMutation.mutate({ to: verifyTarget, reason });
        }}
      />

      <PaymentRefundSheet
        open={refundOpen}
        onOpenChange={setRefundOpen}
        principal={payment.amount}
        pending={refundMutation.isPending}
        error={actionError}
        onConfirm={(amountMinor, reason) => refundMutation.mutate({ amountMinor, reason })}
      />

      <PaymentReverseSheet
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        pending={reverseMutation.isPending}
        error={actionError}
        onConfirm={(reason) => reverseMutation.mutate(reason)}
      />
    </ScreenBleed>
  );
}
