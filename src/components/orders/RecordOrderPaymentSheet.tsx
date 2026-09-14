/**
 * "Record payment" — the one merchant-facing step that tells APSA money
 * arrived for an order.
 *
 * What this sheet is NOT:
 *
 *   - It is not a settlement. record_payment_v1 (migration 035) always writes
 *     the row as status `pending` / verification `unverified`, for cash exactly
 *     as for a bank transfer, and only verifyPaymentFn can move it to `paid`.
 *     So this sheet never says "paid", never shows a success tick, and says out
 *     loud that the claim still has to be confirmed.
 *   - It is not a COD settlement shortcut. Choosing COD records that cash is to
 *     be collected on delivery; it does not assert the money is in hand. The
 *     server requires a different permission for it (payments.mark_cod) and the
 *     caller gates the option on exactly that.
 *   - It computes nothing. The amount is typed by the merchant, parsed once
 *     through parseMinorUnits (integer arithmetic only — never
 *     `parseFloat(x) * 100`), and sent in the order's own currency. There is no
 *     currency picker: offering one would be offering an implicit conversion,
 *     which ARCHITECTURE.md forbids. Nothing here subtracts what is already
 *     received from the order total — how much is still outstanding is derived
 *     in SQL from the payment ledger, and the caller renders the server's own
 *     settlement figures.
 *
 * Retry safety: one idempotency key is minted per opened sheet and reused for
 * every submit attempt from it, so a double tap, a lost response or an explicit
 * retry all replay onto the SAME payment rather than recording a second one.
 * The key is regenerated only when the sheet is opened again for a new payment.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { MINOR_UNIT_DIGITS, formatMoney, parseMinorUnits } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Money, PaymentMethod } from "@/types";

/**
 * Every method record_payment_v1 accepts. `cod` is listed last and gated
 * separately by the caller: it is the one option whose permission differs
 * server-side.
 *
 * Module-local on purpose: exporting a constant beside a component costs a
 * react-refresh warning, and nothing outside this file needs the list.
 */
const RECORD_PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "khqr", "bank_transfer", "cod"];

export interface RecordOrderPaymentSubmit {
  method: PaymentMethod;
  amountMinor: number;
  reference: string | undefined;
  idempotencyKey: string;
}

export function RecordOrderPaymentSheet({
  open,
  onOpenChange,
  orderTotal,
  canRecord,
  canMarkCod,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The order's total, shown for reference and used only to fix the currency
   * of the typed amount. Never used in a calculation.
   */
  orderTotal: Money;
  /** payments.record — cash / KHQR / bank transfer. */
  canRecord: boolean;
  /** payments.mark_cod — the COD option only. */
  canMarkCod: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: (submit: RecordOrderPaymentSubmit) => void;
}) {
  const { t } = useTranslation();

  const methods = RECORD_PAYMENT_METHODS.filter((method) =>
    method === "cod" ? canMarkCod : canRecord,
  );
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? "cash");
  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");

  /*
   * One key per opened sheet, minted on open rather than per submit: every
   * attempt from this sheet — including a retry after a failure whose response
   * was lost in transit — must replay onto the same payment.
   */
  const idempotencyKeyRef = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    setAmountText("");
    setReference("");
    setMethod(methods[0] ?? "cash");
    idempotencyKeyRef.current = newIdempotencyKey();
    // Minting depends only on the sheet opening, not on the derived method list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currency = orderTotal.currency;
  const parsed = parseMinorUnits(amountText, currency);
  const amountValid = parsed !== null && parsed > 0;
  const trimmedReference = reference.trim();

  // A method the member cannot use is never offered, and with none left the
  // caller should not have opened this sheet at all — say so rather than
  // showing an unusable form.
  if (methods.length === 0) return null;

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("order.recordPaymentSheet.title")}
      description={t("order.recordPaymentSheet.body")}
      snap="full"
    >
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="text-label text-text-secondary">
            {t("order.recordPaymentSheet.methodLabel")}
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {methods.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={method === value}
                onClick={() => setMethod(value)}
                className={cn(
                  "press tap-target text-label rounded-xl border px-3 py-3 transition-colors",
                  method === value
                    ? "border-action-primary bg-action-primary-soft text-action-primary"
                    : "border-border-strong bg-surface-primary text-text-primary",
                )}
              >
                <span className="chip-text">{t(`pos.method.${value}`)}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-payment-amount" className="text-label text-text-secondary">
            {t("order.recordPaymentSheet.amountLabel", { currency })}
          </Label>
          <Input
            id="order-payment-amount"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            className="text-financial h-12"
            placeholder={MINOR_UNIT_DIGITS[currency] === 0 ? "0" : "0.00"}
            value={amountText}
            aria-describedby="order-payment-amount-hint"
            onChange={(event) => setAmountText(event.target.value)}
          />
          {/*
           * Read the amount back in the merchant's own terms before anything is
           * sent, so a misplaced decimal is visible here rather than in the
           * ledger.
           */}
          {amountValid ? (
            <span className="text-data tnum text-text-muted">
              {formatMoney({ amount: parsed, currency })}
            </span>
          ) : null}
          <span id="order-payment-amount-hint" className="text-caption text-text-secondary">
            {t("order.recordPaymentSheet.amountHint", { amount: formatMoney(orderTotal) })}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-payment-reference" className="text-label text-text-secondary">
            {t("order.recordPaymentSheet.referenceLabel")}
          </Label>
          <Input
            id="order-payment-reference"
            className="h-12"
            autoComplete="off"
            value={reference}
            aria-describedby="order-payment-reference-hint"
            onChange={(event) => setReference(event.target.value)}
          />
          <span id="order-payment-reference-hint" className="text-caption text-text-secondary">
            {t("order.recordPaymentSheet.referenceHint")}
          </span>
        </div>

        {/*
         * Said plainly, every time: recording is a claim, not a settlement.
         * The merchant confirms receipt afterwards on the payment itself.
         */}
        <p
          className="text-body-sm rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
          role="note"
        >
          {t(
            method === "cod"
              ? "order.recordPaymentSheet.codNote"
              : "order.recordPaymentSheet.pendingNote",
          )}
        </p>

        {error ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {error}
          </p>
        ) : null}

        <Button
          className="tap-target h-12 w-full"
          disabled={pending || !amountValid}
          aria-busy={pending}
          onClick={() => {
            if (parsed === null) return;
            onConfirm({
              method,
              amountMinor: parsed,
              reference: trimmedReference.length > 0 ? trimmedReference : undefined,
              idempotencyKey: idempotencyKeyRef.current,
            });
          }}
        >
          {pending ? t("order.recordPaymentSheet.working") : t("order.recordPaymentSheet.submit")}
        </Button>
      </div>
    </BottomSheet>
  );
}

/**
 * An opaque, single-use retry token. Only its uniqueness matters — the server
 * treats it as an opaque string scoped to the order, and never parses it.
 */
function newIdempotencyKey(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  // Non-crypto fallback for environments without randomUUID (older Safari,
  // some test runners). Collision here would only mean a legitimate second
  // payment was refused as a replay, never a duplicate charge.
  return `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
