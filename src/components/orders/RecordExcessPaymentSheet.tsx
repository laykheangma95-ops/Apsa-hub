/**
 * "Record a transfer above the total" — migration 068, DRAFT pilot policy.
 *
 * For one case only: a bank transfer or KHQR payment that really arrived for
 * more than the order still owes. The full amount received is recorded, and the
 * excess must be returned to the customer through the payment's refund. It is a
 * manager-level action (payments.record_excess) and deliberately a separate
 * sheet: ordinary Record payment keeps refusing any amount above what is owed,
 * so an accidental overpayment is never a cashier action. Cash never comes
 * here — change is given in hand and only the amount kept is recorded.
 *
 * What this sheet is NOT:
 *   - A verification. The transfer reference is required so the money can be
 *     traced on the bank statement; it proves nothing. The payment is recorded
 *     as a claim like any other and is confirmed separately.
 *   - A calculation of what is owed. `outstanding` is the server's figure; it
 *     is sent back as a precondition, and the server refuses the payment
 *     (nothing written) if the outstanding amount changed meanwhile.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { MINOR_UNIT_DIGITS, formatMoney, parseMinorUnits } from "@/lib/money";
import { excessAbove } from "@/lib/payments";
import { cn } from "@/lib/utils";
import type { Money } from "@/types";

const EXCESS_METHODS = ["bank_transfer", "khqr"] as const;
type ExcessMethod = (typeof EXCESS_METHODS)[number];

export interface RecordExcessPaymentSubmit {
  method: ExcessMethod;
  amountMinor: number;
  reference: string;
  reason: string;
  idempotencyKey: string;
  /** The outstanding amount this sheet showed — a precondition, never an amount. */
  expectedOutstandingMinor: number;
}

export function RecordExcessPaymentSheet({
  open,
  onOpenChange,
  outstanding,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the order still owes, from the server's settlement read. */
  outstanding: Money;
  pending: boolean;
  error: string | null;
  onConfirm: (submit: RecordExcessPaymentSubmit) => void;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<ExcessMethod>("bank_transfer");
  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  // One key per opened sheet: every retry from it replays onto one payment.
  const idempotencyKeyRef = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    setMethod("bank_transfer");
    setAmountText("");
    setReference("");
    setReason("");
    idempotencyKeyRef.current = newIdempotencyKey();
  }, [open]);

  const currency = outstanding.currency;
  const parsed = parseMinorUnits(amountText, currency);
  const excess = parsed !== null ? excessAbove(parsed, outstanding) : null;
  const trimmedReference = reference.trim();
  const trimmedReason = reason.trim();
  const ready =
    parsed !== null && excess !== null && trimmedReference.length > 0 && trimmedReason.length > 0;

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("order.recordExcess.title")}
      description={t("order.recordExcess.body")}
      snap="full"
      footer={
        <div>
          {error ? (
            <p className="text-caption mb-2 text-status-danger-text" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            className="tap-target h-12 w-full"
            disabled={pending || !ready}
            aria-busy={pending}
            onClick={() => {
              if (!ready || parsed === null) return;
              onConfirm({
                method,
                amountMinor: parsed,
                reference: trimmedReference,
                reason: trimmedReason,
                idempotencyKey: idempotencyKeyRef.current,
                expectedOutstandingMinor: outstanding.amount,
              });
            }}
          >
            {pending ? t("order.recordExcess.working") : t("order.recordExcess.submit")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body-sm text-text-primary" role="status">
          {t("order.recordExcess.outstanding", { amount: formatMoney(outstanding) })}
        </p>

        <fieldset>
          <legend className="text-label text-text-secondary">
            {t("order.recordPaymentSheet.methodLabel")}
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {EXCESS_METHODS.map((value) => (
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
          <Label htmlFor="order-excess-amount" className="text-label text-text-secondary">
            {t("order.recordExcess.amountLabel", { currency })}
          </Label>
          <Input
            id="order-excess-amount"
            inputMode="decimal"
            enterKeyHint="next"
            autoComplete="off"
            className="text-financial h-12"
            placeholder={MINOR_UNIT_DIGITS[currency] === 0 ? "0" : "0.00"}
            value={amountText}
            aria-describedby="order-excess-amount-hint"
            onChange={(event) => setAmountText(event.target.value)}
          />
          <span id="order-excess-amount-hint" className="text-caption text-text-secondary">
            {excess
              ? t("order.recordExcess.excessPreview", { amount: formatMoney(excess) })
              : parsed !== null
                ? t("order.recordExcess.notAbove")
                : t("order.recordExcess.amountHint")}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-excess-reference" className="text-label text-text-secondary">
            {t("order.recordExcess.referenceLabel")}
          </Label>
          <Input
            id="order-excess-reference"
            className="h-12"
            autoComplete="off"
            value={reference}
            aria-describedby="order-excess-reference-hint"
            onChange={(event) => setReference(event.target.value)}
          />
          <span id="order-excess-reference-hint" className="text-caption text-text-secondary">
            {t("order.recordExcess.referenceHint")}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-excess-reason" className="text-label text-text-secondary">
            {t("order.recordExcess.reasonLabel")}
          </Label>
          <Input
            id="order-excess-reason"
            className="h-12"
            autoComplete="off"
            value={reason}
            aria-describedby="order-excess-reason-hint"
            onChange={(event) => setReason(event.target.value)}
          />
          <span id="order-excess-reason-hint" className="text-caption text-text-secondary">
            {t("order.recordExcess.reasonHint")}
          </span>
        </div>

        <p
          className="text-body-sm rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
          role="note"
        >
          {t("order.recordExcess.pendingNote")}
        </p>
      </div>
    </BottomSheet>
  );
}

function newIdempotencyKey(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  return `excess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
