/**
 * /app/returns/$returnId — one customer return, and its next step.
 *
 *   Requested → Receive return → Inspect (per line: how many damaged; the
 *   rest resellable) → Complete return
 *
 * Every decision is the server's (src/server/returns/service.ts and migration
 * 056's RPCs):
 *   - receiving and inspecting write no stock;
 *   - completing appends, per line, a `return` of +quantity and — when some
 *     units are damaged — a `damage` of −damaged, so only resellable units
 *     become sellable. Stock is never written as a number;
 *   - completion names the inspection shown here; if it changed in between,
 *     the server refuses as `stale`, writes nothing, and the new figures are
 *     shown before the merchant confirms again;
 *   - repeating a step that already happened is a replay that writes nothing.
 *
 * orders.return + orders.read are re-checked on every call. The capability
 * checks here only decide what is offered. No price, phone or address is shown.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, PackageCheck, PackageOpen, PackageX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  DetailSkeleton,
  QuantityStepper,
  ScreenBleed,
  Section,
  Timeline,
  type TimelineItem,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { OperationalState } from "@/components/common/OperationalState";
import { ReturnStatusLabel } from "@/components/returns/ReturnStatusLabel";
import { useCapabilities } from "@/hooks/use-capabilities";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { inventoryKeys } from "@/lib/inventory";
import {
  buildInspection,
  classifyReturnError,
  completeCustomerReturn,
  currentInspection,
  getCustomerReturn,
  inspectCustomerReturn,
  ledgerEffect,
  receiveCustomerReturn,
  returnErrorKey,
  returnStepMessageKey,
  returnTotals,
  returnsKeys,
  type ReturnDetail,
  type ReturnDetailResult,
  type ReturnStepResult,
} from "@/lib/returns";

export const Route = createFileRoute("/app/returns/$returnId")({
  head: () => ({
    meta: [{ title: "Customer return — APSA" }, { name: "robots", content: "noindex" }],
  }),
  component: ReturnDetailRoute,
});

function ReturnDetailRoute() {
  const { session, organizationId } = Route.useRouteContext();
  const { returnId } = Route.useParams();
  return (
    <ReturnDetailScreen
      key={`${session.userId}/${organizationId}/${returnId}`}
      userId={session.userId}
      organizationId={organizationId}
      returnId={returnId}
    />
  );
}

function lineName(line: { productName: string; variantName: string | null }): string {
  return line.variantName ? `${line.productName} · ${line.variantName}` : line.productName;
}

function ReturnDetailScreen({
  userId,
  organizationId,
  returnId,
}: {
  userId: string;
  organizationId: string;
  returnId: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  const identityOk =
    Boolean(userId) &&
    Boolean(organizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === organizationId);
  // Offered only; every returns call re-checks both server-side.
  const canReturn =
    identityOk && capabilities.can("orders.return") && capabilities.can("orders.read");

  const detailKey = returnsKeys.detail(userId, organizationId, returnId);
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => getCustomerReturn(returnId),
    enabled: canReturn,
  });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [damaged, setDamaged] = useState<Record<string, number>>({});

  const detail = detailQuery.data?.kind === "return" ? detailQuery.data.detail : null;

  function showDetail(next: ReturnDetail) {
    const value: ReturnDetailResult = { kind: "return", detail: next };
    queryClient.setQueryData(detailKey, () => value);
    void queryClient.invalidateQueries({ queryKey: returnsKeys.list(userId, organizationId) });
  }

  function startInspection(from: ReturnDetail) {
    const draft: Record<string, number> = {};
    for (const line of from.lines) draft[line.returnItemId] = line.damagedQuantity ?? 0;
    setDamaged(draft);
    setEditing(true);
    setMessage(null);
  }

  async function runStep(step: () => Promise<ReturnStepResult>, onOk?: () => void) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await step();
      if (result.kind === "ok") {
        showDetail(result.detail);
        setEditing(false);
        if (result.replayed) setMessage(t("returns.replayed"));
        onOk?.();
        return;
      }
      if (result.kind === "stale") {
        // Nothing was written. Show the inspection as it is now.
        showDetail(result.detail);
        setEditing(false);
      }
      setMessage(t(returnStepMessageKey(result) ?? "returns.error.generic"));
    } catch (err) {
      setMessage(t(returnErrorKey(classifyReturnError(err))));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <AppHeader
      title={
        detail
          ? t("returns.detail.order", { number: detail.orderNumber })
          : t("returns.detail.title")
      }
      onBack={() => void navigate({ to: "/app/returns" })}
    />
  );

  if (!canReturn) {
    return (
      <ScreenBleed surface="raised" bottom="none">
        {header}
        <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6">
          <CapabilityDeniedState capabilities={capabilities} />
        </main>
      </ScreenBleed>
    );
  }

  const inspecting = detail !== null && (detail.status === "received" || editing);
  // Untouched lines start at what is recorded (0 damaged before any inspection).
  const draft: Record<string, number> = {};
  for (const line of detail?.lines ?? []) {
    draft[line.returnItemId] = damaged[line.returnItemId] ?? line.damagedQuantity ?? 0;
  }
  const draftInspection = detail && inspecting ? buildInspection(detail, draft) : null;
  const draftTotals =
    detail && inspecting
      ? returnTotals(
          detail.lines.map((line) => ({
            quantity: line.quantity,
            damagedQuantity: draft[line.returnItemId] ?? 0,
          })),
        )
      : null;

  const historyItems: TimelineItem[] = detail
    ? [...detail.history].reverse().map((event, index) => ({
        id: `${event.at}-${index}`,
        title: t(`returns.history.${event.toStatus}`),
        meta: new Date(event.at).toLocaleString(i18n.language),
        tone: event.toStatus === "completed" ? "success" : "default",
      }))
    : [];

  return (
    <ScreenBleed surface="raised" bottom="none">
      {header}

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {detailQuery.isLoading ? <DetailSkeleton /> : null}

        {detailQuery.isError ? (
          <OperationalState
            tone="danger"
            title={t("returns.list.errorTitle")}
            body={t("returns.list.errorBody")}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : null}

        {detailQuery.data?.kind === "return_not_found" ? (
          <OperationalState
            title={t("returns.detail.notFoundTitle")}
            body={t("returns.detail.notFoundBody")}
            action={
              <Button
                variant="outline"
                className="tap-target h-11"
                onClick={() => void navigate({ to: "/app/returns" })}
              >
                {t("returns.detail.back")}
              </Button>
            }
          />
        ) : null}

        {detail ? (
          <div className="content-in flex flex-col gap-4">
            <Section
              title={t("returns.detail.linesTitle")}
              action={<ReturnStatusLabel status={detail.status} />}
            >
              <ul className="flex flex-col gap-3" aria-label={t("returns.detail.linesTitle")}>
                {detail.lines.map((line) => {
                  const name = lineName(line);
                  const value = draft[line.returnItemId] ?? 0;
                  return (
                    <li
                      key={line.returnItemId}
                      className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-primary px-3 py-2"
                    >
                      <span className="text-label text-text-primary" lang="km">
                        {name}
                      </span>
                      <span className="text-caption tnum text-text-secondary">
                        {t("returns.detail.quantity", { count: line.quantity })}
                      </span>
                      {inspecting ? (
                        <div className="flex flex-col gap-1">
                          <div
                            role="group"
                            aria-label={t("returns.inspect.damagedLabel", { name })}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="text-body-sm flex items-center gap-1.5 text-text-secondary">
                              <PackageX className="size-4 shrink-0" aria-hidden />
                              {t("returns.inspect.damaged")}
                            </span>
                            <QuantityStepper
                              value={value}
                              min={0}
                              max={line.quantity}
                              onChange={(next) =>
                                setDamaged((current) => ({ ...current, [line.returnItemId]: next }))
                              }
                            />
                          </div>
                          <span className="text-caption tnum text-text-secondary">
                            {t("returns.detail.split", {
                              resellable: line.quantity - value,
                              damaged: value,
                            })}
                          </span>
                        </div>
                      ) : line.damagedQuantity === null ? (
                        <span className="text-caption text-text-muted">
                          {t("returns.detail.notInspected")}
                        </span>
                      ) : (
                        <span className="text-caption tnum text-text-secondary">
                          {t("returns.detail.split", {
                            resellable: line.resellableQuantity ?? 0,
                            damaged: line.damagedQuantity,
                          })}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>

            {detail.status === "requested" ? (
              <Section title={t("returns.receive.title")}>
                <div className="flex flex-col gap-3">
                  <p className="text-body-sm text-text-secondary">{t("returns.receive.body")}</p>
                  <Button
                    className="tap-target h-12 w-full gap-2"
                    disabled={busy}
                    aria-busy={busy}
                    onClick={() => void runStep(() => receiveCustomerReturn(detail.returnId))}
                  >
                    <PackageOpen className="size-4" aria-hidden />
                    {busy ? t("returns.receive.submitting") : t("returns.action.receive")}
                  </Button>
                </div>
              </Section>
            ) : null}

            {inspecting ? (
              <Section title={t("returns.inspect.title")}>
                <div className="flex flex-col gap-3">
                  <p className="text-body-sm text-text-secondary">{t("returns.inspect.body")}</p>
                  {draftTotals &&
                  draftTotals.resellable !== null &&
                  draftTotals.damaged !== null ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                      <dt className="text-body-sm text-text-secondary">
                        {t("returns.inspect.resellable")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {draftTotals.resellable}
                      </dd>
                      <dt className="text-body-sm text-text-secondary">
                        {t("returns.inspect.damaged")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {draftTotals.damaged}
                      </dd>
                    </dl>
                  ) : null}
                  <Button
                    className="tap-target h-12 w-full gap-2"
                    disabled={busy || draftInspection === null}
                    aria-busy={busy}
                    onClick={() => {
                      if (draftInspection) {
                        void runStep(() => inspectCustomerReturn(detail.returnId, draftInspection));
                      }
                    }}
                  >
                    <ClipboardCheck className="size-4" aria-hidden />
                    {busy ? t("returns.inspect.submitting") : t("returns.action.inspect")}
                  </Button>
                  {editing && detail.status === "inspected" ? (
                    <Button
                      variant="outline"
                      className="tap-target h-12 w-full"
                      disabled={busy}
                      onClick={() => setEditing(false)}
                    >
                      {t("returns.inspect.cancelEdit")}
                    </Button>
                  ) : null}
                </div>
              </Section>
            ) : null}

            {detail.status === "inspected" && !editing ? (
              <CompletePanel
                detail={detail}
                busy={busy}
                onEdit={() => startInspection(detail)}
                onComplete={(expected) =>
                  void runStep(
                    () => completeCustomerReturn(detail.returnId, expected),
                    () => {
                      // The ledger moved: stock and Home read from it.
                      void queryClient.invalidateQueries({
                        queryKey: inventoryKeys.principal(userId, organizationId),
                      });
                      void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
                    },
                  )
                }
              />
            ) : null}

            {detail.status === "completed" ? (
              <Section>
                <div className="flex flex-col items-center gap-2 py-2 text-center" role="status">
                  <CheckCircle2 className="size-8 text-status-success" aria-hidden />
                  <p className="text-h3 text-text-primary">{t("returns.completed.title")}</p>
                  <p className="text-body-sm text-text-secondary">{t("returns.completed.body")}</p>
                </div>
              </Section>
            ) : null}

            <div role="status" aria-live="polite">
              {message ? <p className="text-caption text-status-warning-text">{message}</p> : null}
            </div>

            <Section title={t("returns.detail.historyTitle")}>
              <Timeline items={historyItems} />
            </Section>
          </div>
        ) : null}
      </main>
    </ScreenBleed>
  );
}

function CompletePanel({
  detail,
  busy,
  onEdit,
  onComplete,
}: {
  detail: ReturnDetail;
  busy: boolean;
  onEdit: () => void;
  onComplete: (expected: NonNullable<ReturnType<typeof currentInspection>>) => void;
}) {
  const { t } = useTranslation();
  const expected = currentInspection(detail);
  const resellable = detail.totals.resellable ?? 0;
  const damagedTotal = detail.totals.damaged ?? 0;

  return (
    <Section title={t("returns.complete.title")}>
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-text-secondary">{t("returns.complete.body")}</p>
        <ul className="flex flex-col gap-2" aria-label={t("returns.complete.title")}>
          {detail.lines.map((line) => {
            const effect = ledgerEffect(line.quantity, line.damagedQuantity ?? 0);
            return (
              <li key={line.returnItemId} className="flex flex-col gap-0.5">
                <span className="text-label text-text-primary" lang="km">
                  {lineName(line)}
                </span>
                <span className="text-body-sm flex items-center gap-1.5 text-text-secondary">
                  <PackageCheck className="size-4 shrink-0" aria-hidden />
                  {t("returns.complete.backToStock", { count: effect.sellableChange })}
                </span>
                {effect.damageDelta !== 0 ? (
                  <span className="text-body-sm flex items-center gap-1.5 text-text-secondary">
                    <PackageX className="size-4 shrink-0" aria-hidden />
                    {t("returns.complete.recordedDamaged", { count: -effect.damageDelta })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-body-sm text-text-secondary">
            {t("returns.complete.totalResellable")}
          </dt>
          <dd className="text-financial tnum text-end text-text-primary">{resellable}</dd>
          <dt className="text-body-sm text-text-secondary">{t("returns.complete.totalDamaged")}</dt>
          <dd className="text-financial tnum text-end text-text-primary">{damagedTotal}</dd>
        </dl>
        <Button
          className="tap-target h-12 w-full gap-2"
          disabled={busy || expected === null}
          aria-busy={busy}
          onClick={() => {
            if (expected) onComplete(expected);
          }}
        >
          <CheckCircle2 className="size-4" aria-hidden />
          {busy ? t("returns.complete.submitting") : t("returns.action.complete")}
        </Button>
        <Button
          variant="outline"
          className="tap-target h-12 w-full"
          disabled={busy}
          onClick={onEdit}
        >
          {t("returns.inspect.edit")}
        </Button>
      </div>
    </Section>
  );
}
