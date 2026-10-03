/**
 * /app/returns/new — Request a customer return.
 *
 *   order number → the delivered order's lines (ordered / already returned /
 *   can return) → choose quantities → Request return → /app/returns/$returnId
 *
 * Every decision is the server's (src/server/returns/service.ts and migration
 * 056's request_customer_return_v1):
 *   - the order is resolved inside the caller's organization — another
 *     tenant's order number reads exactly like an unknown one;
 *   - only a confirmed/completed order with a DELIVERED delivery can be
 *     returned, and the returnable quantities come from the database and are
 *     re-checked under the order lock, so the quantities chosen here are a
 *     request, never the truth;
 *   - requesting writes no stock.
 *
 * Duplicate safety: one request key per requested return, held across retries
 * of the same request and released once the server recorded it.
 *
 * No price, phone or address is shown or sent from this screen.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Undo2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, QuantityStepper, ScreenBleed, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { createIdempotencyKeyHolder } from "@/lib/idempotency";
import {
  MAX_ORDER_NUMBER_LENGTH,
  buildReturnRequest,
  classifyReturnError,
  findReturnableOrder,
  normalizeOrderNumber,
  requestCustomerReturn,
  requestReturnMessageKey,
  returnErrorKey,
  returnRequestFingerprint,
  returnableOrderMessageKey,
  returnsKeys,
  type ReturnableOrder,
} from "@/lib/returns";

export const Route = createFileRoute("/app/returns/new")({
  head: () => ({
    meta: [{ title: "New return — APSA" }, { name: "robots", content: "noindex" }],
  }),
  component: NewReturnRoute,
});

function NewReturnRoute() {
  const { session, organizationId } = Route.useRouteContext();
  // Keyed by principal: a different member or organization in this tab starts
  // from a blank request, never from the previous member's order.
  return (
    <NewReturnScreen
      key={`${session.userId}/${organizationId}`}
      userId={session.userId}
      organizationId={organizationId}
    />
  );
}

function NewReturnScreen({ userId, organizationId }: { userId: string; organizationId: string }) {
  const { t } = useTranslation();
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

  const [orderText, setOrderText] = useState("");
  const [order, setOrder] = useState<ReturnableOrder | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyHolder = useRef(createIdempotencyKeyHolder());

  async function findOrder(event: FormEvent) {
    event.preventDefault();
    const orderNumber = normalizeOrderNumber(orderText);
    if (orderNumber === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await findReturnableOrder(orderNumber);
      if (result.kind === "order") {
        setOrder(result.order);
        setQuantities({});
      } else {
        setMessage(t(returnableOrderMessageKey(result) ?? "returns.error.generic"));
      }
    } catch (err) {
      setMessage(t(returnErrorKey(classifyReturnError(err))));
    } finally {
      setBusy(false);
    }
  }

  const request = order ? buildReturnRequest(order, quantities) : null;
  const nothingReturnable = order !== null && order.lines.every((l) => l.returnableQuantity === 0);

  async function submit() {
    if (!order || !request || busy) return;
    // Same request → same key, so a retry after a lost response is replayed by
    // the server instead of creating a second return.
    const requestKey = keyHolder.current.keyFor(returnRequestFingerprint(order.orderId, request));
    setBusy(true);
    setMessage(null);
    try {
      const result = await requestCustomerReturn(requestKey, order.orderId, request);
      if (result.kind === "requested") {
        keyHolder.current.release();
        void queryClient.invalidateQueries({
          queryKey: returnsKeys.principal(userId, organizationId),
        });
        void navigate({ to: "/app/returns/$returnId", params: { returnId: result.returnId } });
        return;
      }
      // Refused: nothing was written. A changed request gets a new key.
      keyHolder.current.release();
      setMessage(t(requestReturnMessageKey(result) ?? "returns.error.generic"));
    } catch (err) {
      // Key kept: retrying the same request after a network failure must reach
      // the server under the same key.
      setMessage(t(returnErrorKey(classifyReturnError(err))));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenBleed surface="raised" bottom="none">
      <AppHeader
        title={t("returns.request.title")}
        subtitle={t("returns.request.subtitle")}
        onBack={() => void navigate({ to: "/app/returns" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canReturn ? (
          <CapabilityDeniedState capabilities={capabilities} />
        ) : (
          <div className="content-in flex flex-col gap-4">
            {order === null ? (
              <Section title={t("returns.request.findTitle")}>
                <form className="flex flex-col gap-2" onSubmit={(event) => void findOrder(event)}>
                  <Label htmlFor="return-order" className="text-label text-text-secondary">
                    {t("returns.request.orderLabel")}
                  </Label>
                  <Input
                    id="return-order"
                    className="tnum h-12"
                    value={orderText}
                    maxLength={MAX_ORDER_NUMBER_LENGTH}
                    autoComplete="off"
                    autoFocus
                    disabled={busy}
                    aria-describedby="return-order-hint"
                    placeholder={t("returns.request.orderPlaceholder")}
                    onChange={(event) => setOrderText(event.target.value)}
                  />
                  <span id="return-order-hint" className="text-caption text-text-secondary">
                    {t("returns.request.orderHint")}
                  </span>
                  <Button
                    type="submit"
                    variant="outline"
                    className="tap-target h-12 gap-2"
                    disabled={busy || normalizeOrderNumber(orderText) === null}
                    aria-busy={busy}
                  >
                    <Search className="size-4" aria-hidden />
                    {busy ? t("returns.request.finding") : t("returns.request.find")}
                  </Button>
                </form>
              </Section>
            ) : (
              <Section
                title={t("returns.request.linesTitle")}
                action={
                  <span className="text-caption tnum text-text-secondary">
                    {t("returns.list.order", { number: order.orderNumber })}
                  </span>
                }
              >
                <div className="flex flex-col gap-3">
                  {nothingReturnable ? (
                    <p className="text-body-sm text-text-secondary">
                      {t("returns.request.nothingReturnable")}
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-3" aria-label={t("returns.request.linesTitle")}>
                    {order.lines.map((line) => {
                      const name = line.variantName
                        ? `${line.productName} · ${line.variantName}`
                        : line.productName;
                      return (
                        <li
                          key={line.orderItemId}
                          className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-primary px-3 py-2"
                        >
                          <span className="text-label text-text-primary" lang="km">
                            {name}
                          </span>
                          <span className="text-caption tnum flex flex-wrap gap-x-3 text-text-secondary">
                            <span>
                              {t("returns.request.ordered", { count: line.orderedQuantity })}
                            </span>
                            {line.alreadyReturned > 0 ? (
                              <span>
                                {t("returns.request.alreadyReturned", {
                                  count: line.alreadyReturned,
                                })}
                              </span>
                            ) : null}
                            <span>
                              {t("returns.request.returnable", { count: line.returnableQuantity })}
                            </span>
                          </span>
                          {line.returnableQuantity > 0 ? (
                            <div
                              role="group"
                              aria-label={t("returns.request.quantityLabel", { name })}
                            >
                              <QuantityStepper
                                value={quantities[line.orderItemId] ?? 0}
                                min={0}
                                max={line.returnableQuantity}
                                onChange={(value) =>
                                  setQuantities((current) => ({
                                    ...current,
                                    [line.orderItemId]: value,
                                  }))
                                }
                              />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {!nothingReturnable && request === null ? (
                    <p className="text-caption text-text-secondary">
                      {t("returns.request.selectHint")}
                    </p>
                  ) : null}
                  <Button
                    className="tap-target h-12 w-full gap-2"
                    disabled={busy || request === null}
                    aria-busy={busy}
                    onClick={() => void submit()}
                  >
                    <Undo2 className="size-4" aria-hidden />
                    {busy ? t("returns.request.submitting") : t("returns.request.submit")}
                  </Button>
                  <Button
                    variant="outline"
                    className="tap-target h-12 w-full"
                    disabled={busy}
                    onClick={() => {
                      setOrder(null);
                      setQuantities({});
                      setMessage(null);
                      keyHolder.current.release();
                    }}
                  >
                    {t("returns.request.changeOrder")}
                  </Button>
                </div>
              </Section>
            )}

            <div role="status" aria-live="polite">
              {message ? <p className="text-caption text-status-warning-text">{message}</p> : null}
            </div>
          </div>
        )}
      </main>
    </ScreenBleed>
  );
}
