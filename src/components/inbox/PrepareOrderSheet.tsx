import { motion } from "motion/react";
import { Check, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet, ErrorState, QuantityStepper } from "@/design-system";
import {
  createOrder,
  createRealOrder,
  confirmRealOrder,
  cancelRealOrder,
  isProductionId,
  PERMISSION_DENIED,
} from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { classifyOrderError, channelToSourceDb, type RealOrderDetail } from "@/lib/orders";
import { addMoney, formatMoney, multiplyMoney, usd } from "@/lib/money";
import { defaultVariantSelection, variantLabel } from "@/lib/order-draft";
import type { PrepareOrderItemInput } from "@/lib/conversation/smart-actions";
import { cn } from "@/lib/utils";
import type { Channel, Customer, Order, Product } from "@/types";

interface PrepareOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
  displayName: string;
  channel: Channel;
  /** the merchant's catalog — already fetched by the caller, never refetched here */
  products: Product[];
  /** review-step starting point; empty array means "start from a blank search" */
  initialItems: PrepareOrderItemInput[];
  /**
   * Opaque provenance identifier for the conversation this order came from.
   * Only ever sent on the production create-order call — see migration 030's
   * own comment on why this is never a Conversation FK or content.
   */
  sourceConversationRef?: string | null;
  /** Fires exactly once, when the order first exists (draft or, for the mock path, final). */
  onCreated: (order: Order) => void;
  /** Fires when a draft is confirmed — a status update, not a second "created" event. */
  onConfirmed?: (order: Order) => void;
}

let lineKeySeq = 0;
function nextLineKey(): string {
  lineKeySeq += 1;
  return `line-${lineKeySeq}`;
}

interface EditableLine {
  key: string;
  quantity: number;
  product: Product | null;
  variant: Record<string, string>;
  /** shown as a picker until the merchant chooses one, or searches instead */
  candidates: Product[];
  query: string;
}

function toEditableLine(input: PrepareOrderItemInput): EditableLine {
  return {
    key: nextLineKey(),
    quantity: Math.max(1, Math.trunc(input.quantity) || 1),
    product: input.product ?? null,
    variant: input.product ? defaultVariantSelection(input.product.options) : {},
    candidates: input.candidates ?? [],
    query: "",
  };
}

/** A production order needs a real product AND a real variant on every line. */
function isProductionReady(line: EditableLine): boolean {
  return Boolean(
    line.product && isProductionId(line.product.id) && isProductionId(line.product.variantId ?? ""),
  );
}

type Step =
  | { name: "review" }
  | { name: "created-mock"; order: Order }
  | { name: "created-real"; detail: RealOrderDetail };

export function PrepareOrderSheet({
  open,
  onOpenChange,
  customer,
  displayName,
  channel,
  products,
  initialItems,
  sourceConversationRef,
  onCreated,
  onConfirmed,
}: PrepareOrderSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [lines, setLines] = useState<EditableLine[]>(() =>
    (initialItems.length > 0 ? initialItems : [{ quantity: 1 }]).map(toEditableLine),
  );
  const [step, setStep] = useState<Step>({ name: "review" });
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<"generic" | "permission" | null>(null);
  const submittingRef = useRef(false);

  function reset() {
    setLines((initialItems.length > 0 ? initialItems : [{ quantity: 1 }]).map(toEditableLine));
    setStep({ name: "review" });
    setSubmitting(false);
    setConfirming(false);
    setFailure(null);
    submittingRef.current = false;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function updateLine(key: string, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));
  }

  function pickProduct(key: string, product: Product) {
    updateLine(key, {
      product,
      candidates: [],
      variant: defaultVariantSelection(product.options),
      query: "",
    });
  }

  const readyToSubmit = lines.length > 0 && lines.every((line) => Boolean(line.product));

  const estimatedTotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) =>
          line.product ? addMoney(sum, multiplyMoney(line.product.price, line.quantity)) : sum,
        usd(0),
      ),
    [lines],
  );

  async function submit() {
    if (submittingRef.current || !readyToSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);

    const readyLines = lines.filter((line): line is EditableLine & { product: Product } =>
      Boolean(line.product),
    );

    try {
      const useRealOrders = isProductionId(customer.id) && readyLines.every(isProductionReady);

      if (useRealOrders) {
        const detail = await createRealOrder({
          source: channelToSourceDb(channel),
          items: readyLines.map((line) => ({
            // isProductionReady() above guarantees these are present.
            variantId: line.product.variantId!,
            quantity: line.quantity,
            productId: line.product.id,
          })),
          customerId: customer.id,
          ...(sourceConversationRef ? { sourceConversationRef } : {}),
        });
        setStep({ name: "created-real", detail });
        onCreated(detail.order);
      } else {
        const order = await createOrder({
          customerId: customer.id,
          channel,
          items: readyLines.map((line) => ({
            productId: line.product.id,
            nameKm: line.product.nameKm,
            nameEn: line.product.nameEn,
            ...(variantLabel(line.variant) ? { variant: variantLabel(line.variant)! } : {}),
            quantity: line.quantity,
            unitPrice: line.product.price,
          })),
          subtotal: estimatedTotal,
          discount: usd(0),
          deliveryFee: usd(0),
          total: estimatedTotal,
        });
        setStep({ name: "created-mock", order });
        onCreated(order);
      }
    } catch (error) {
      if (error instanceof Error && error.message === PERMISSION_DENIED) {
        setFailure("permission");
      } else {
        setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function confirm() {
    if (step.name !== "created-real" || confirming) return;
    setConfirming(true);
    setFailure(null);
    try {
      const confirmed = await confirmRealOrder(step.detail.order.id);
      setStep({ name: "created-real", detail: confirmed });
      onConfirmed?.(confirmed.order);
    } catch (error) {
      setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
    } finally {
      setConfirming(false);
    }
  }

  /**
   * "Edit" on an already-created draft cannot patch the persisted order — the
   * Order domain deliberately has no arbitrary update path (see
   * src/server/orders/service.ts). The honest equivalent is: cancel the draft
   * (a real, supported transition that reverses nothing, since a draft never
   * consumed stock) and let the merchant build a fresh one from the same
   * starting lines.
   */
  async function discardAndEdit() {
    if (step.name !== "created-real") return;
    try {
      await cancelRealOrder(step.detail.order.id, "Merchant edited before confirming");
    } catch {
      // Best-effort: if cancellation fails (e.g. permission), the merchant can
      // still cancel it later from Order Detail. Editing must not get stuck.
    }
    setStep({ name: "review" });
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={step.name === "review" ? t("conversation.prepareOrder.reviewTitle") : undefined}
      snap="full"
      className="lg:max-w-[520px]"
    >
      {step.name === "review" ? (
        <div className="space-y-5 pb-4">
          <section className="rounded-xl border border-border-default bg-surface-secondary px-3 py-2.5">
            <p className="text-caption text-text-muted">
              {t("conversation.prepareOrder.customer")}
            </p>
            <p className="text-label text-text-primary">{displayName}</p>
          </section>

          {lines.map((line, index) => (
            <section
              key={line.key}
              className="space-y-3 rounded-xl border border-border-default p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-caption text-text-muted">
                  {t("conversation.prepareOrder.item", { index: index + 1 })}
                </p>
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    aria-label={t("conversation.prepareOrder.remove")}
                    className="tap-target flex size-8 items-center justify-center rounded-full text-text-muted"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>

              {line.product ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-label truncate text-text-primary">
                        {localName(line.product, language)}
                      </p>
                      <p className="text-data text-text-muted">{line.product.sku}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateLine(line.key, { product: null, query: "" })}
                      className="tap-target text-label shrink-0 px-2 text-action-primary"
                    >
                      {t("conversation.prepareOrder.changeProduct")}
                    </button>
                  </div>

                  {line.product.options?.map((option) => (
                    <div key={option.name}>
                      <p className="text-label text-text-secondary capitalize">{option.name}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {option.values.map((value) => {
                          const selected = line.variant[option.name] === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              aria-pressed={selected}
                              onClick={() =>
                                updateLine(line.key, {
                                  variant: { ...line.variant, [option.name]: value },
                                })
                              }
                              className={cn(
                                "tap-target rounded-full border px-4 text-label transition-colors",
                                selected
                                  ? "border-action-primary bg-action-primary text-text-on-action"
                                  : "border-border-strong bg-surface-primary text-text-primary",
                              )}
                            >
                              <span className="chip-text">{value}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  <div className="flex items-center justify-between gap-3">
                    <span className="text-label text-text-secondary">
                      {t("conversation.prepareOrder.quantity")}
                    </span>
                    <QuantityStepper
                      value={line.quantity}
                      onChange={(quantity) => updateLine(line.key, { quantity })}
                      {...(line.product.stock != null ? { max: line.product.stock } : {})}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-body-sm text-text-secondary">
                      {formatMoney(line.product.price)} × {line.quantity}
                    </span>
                    <span className="text-financial text-text-primary">
                      {formatMoney(multiplyMoney(line.product.price, line.quantity))}
                    </span>
                  </div>
                </div>
              ) : line.candidates.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-body-sm text-text-secondary">
                    {t("conversation.prepareOrder.multipleMatches")}
                  </p>
                  <ul className="space-y-2">
                    {line.candidates.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          onClick={() => pickProduct(line.key, candidate)}
                          className="tap-target flex w-full items-center justify-between gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left hover:bg-surface-secondary"
                        >
                          <span className="min-w-0 flex-1 truncate text-label text-text-primary">
                            {localName(candidate, language)}
                          </span>
                          <span className="text-financial shrink-0 text-text-primary">
                            {formatMoney(candidate.price)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ProductSearch
                  products={products}
                  language={language}
                  query={line.query}
                  onQueryChange={(query) => updateLine(line.key, { query })}
                  onPick={(product) => pickProduct(line.key, product)}
                />
              )}
            </section>
          ))}

          <div className="rounded-xl border border-border-default bg-surface-secondary p-3">
            <div className="flex items-center justify-between">
              <span className="text-label text-text-primary">
                {t("conversation.prepareOrder.estimatedTotal")}
              </span>
              <span className="text-financial-lg text-text-primary">
                {formatMoney(estimatedTotal)}
              </span>
            </div>
            <p className="text-caption mt-1 text-text-muted">
              {t("conversation.prepareOrder.estimatedNote")}
            </p>
          </div>

          {failure ? (
            <ErrorState
              title={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.title"
                  : "conversation.prepareOrder.error.title",
              )}
              body={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.body"
                  : "conversation.prepareOrder.error.body",
              )}
              onRetry={() => void submit()}
              className="py-4"
            />
          ) : null}

          <Button
            className="tap-target h-12 w-full"
            disabled={!readyToSubmit || submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? t("conversation.prepareOrder.creating")
              : t(
                  isProductionId(customer.id)
                    ? "conversation.prepareOrder.createDraft"
                    : "conversation.prepareOrder.createOrder",
                )}
          </Button>
          {!readyToSubmit ? (
            <p className="text-caption text-center text-text-muted">
              {t("conversation.prepareOrder.resolveItemsFirst")}
            </p>
          ) : null}
        </div>
      ) : step.name === "created-mock" ? (
        <CreatedCelebration code={step.order.code} />
      ) : (
        <div className="space-y-5 pb-4">
          <CreatedCelebration code={step.detail.order.code} />

          {failure ? (
            <ErrorState
              title={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.title"
                  : "conversation.prepareOrder.error.title",
              )}
              body={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.body"
                  : "conversation.prepareOrder.error.body",
              )}
              className="py-2"
            />
          ) : null}

          {step.detail.order.lifecycleStatus === "confirmed" ? (
            <p className="text-body text-center text-text-secondary">
              {t("conversation.prepareOrder.confirmed")}
            </p>
          ) : (
            <Button
              className="tap-target h-12 w-full"
              disabled={confirming}
              onClick={() => void confirm()}
            >
              {confirming
                ? t("conversation.prepareOrder.confirming")
                : t("conversation.prepareOrder.confirmOrder")}
            </Button>
          )}

          <div className="flex gap-2">
            {step.detail.order.lifecycleStatus !== "confirmed" ? (
              <button
                type="button"
                onClick={() => void discardAndEdit()}
                className="press tap-target text-label flex-1 rounded-full border border-border-default px-4 py-3 text-text-primary"
              >
                {t("conversation.prepareOrder.discardDraft")}
              </button>
            ) : null}
            <a
              href={`/app/orders/${step.detail.order.id}`}
              className="press tap-target text-label flex-1 rounded-full border border-border-default px-4 py-3 text-center text-text-primary"
            >
              {t("conversation.prepareOrder.viewOrder")}
            </a>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function CreatedCelebration({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <motion.div
      className="flex flex-col items-center py-6 text-center"
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.42, ease: [0.34, 1.3, 0.64, 1] }}
      role="status"
    >
      <motion.span
        className="flex size-16 items-center justify-center rounded-full text-text-inverse"
        style={{ backgroundColor: "var(--companion-minto)" }}
        initial={{ scale: 0.6 }}
        animate={{ scale: [0.6, 1.12, 1] }}
        transition={{ duration: 0.5, ease: [0.34, 1.3, 0.64, 1] }}
      >
        <Check className="size-8" aria-hidden />
      </motion.span>
      <p className="text-h2 mt-4 text-text-primary">
        {t("conversation.prepareOrder.draftCreated", { code })}
      </p>
    </motion.div>
  );
}

interface ProductSearchProps {
  products: Product[];
  language: "km" | "en";
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (product: Product) => void;
}

function ProductSearch({ products, language, query, onQueryChange, onPick }: ProductSearchProps) {
  const { t } = useTranslation();
  const q = query.trim().toLowerCase();
  const list = q
    ? products.filter(
        (p) =>
          p.nameEn.toLowerCase().includes(q) ||
          p.nameKm.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q),
      )
    : products;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("conversation.prepareOrder.searchProducts")}
          aria-label={t("conversation.prepareOrder.searchProducts")}
          className="h-11 pl-9"
        />
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {list.slice(0, 20).map((product) => (
          <li key={product.id}>
            <button
              type="button"
              onClick={() => onPick(product)}
              disabled={product.stock === 0}
              className="tap-target flex w-full items-center gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left hover:bg-surface-secondary disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="text-label block truncate text-text-primary">
                  {localName(product, language)}
                </span>
                <span className="text-caption tnum block truncate text-text-muted">
                  {product.sku}
                </span>
              </span>
              <span className="text-financial shrink-0 text-text-primary">
                {formatMoney(product.price)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
