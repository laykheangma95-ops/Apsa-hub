/**
 * The three merchant-facing Payment actions, each a thin capture step in front
 * of an existing server function.
 *
 * None of these sheets decides anything. They collect the one or two inputs
 * the matching server function already validates (a target verification state,
 * an amount in minor units, a reason), disable submit early so the merchant is
 * not surprised by a 400, and hand the result to the caller. The Payment
 * domain re-checks the permission, the current state, the amount and the
 * reason on its own — see src/server/payments/service.ts.
 *
 * There is deliberately no "mark as paid" sheet. `staff_confirmed` is the real,
 * existing manual-confirmation move through the authoritative state machine
 * (payments.manual_confirm), and its consequence — status becoming `paid` —
 * is derived server-side by resultingPaymentStatus, never proposed from here.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { MINOR_UNIT_DIGITS, formatMoney, parseMinorUnits } from "@/lib/money";
import type { PaymentVerificationState } from "@/lib/payments";
import type { Money } from "@/types";

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Reason is OPTIONAL here, because verifyPaymentFn accepts a nullish reason —
 * requiring one in the UI that the server does not require would be inventing
 * a rule. It still matters: the reason is written into the immutable event
 * ledger, so the sheet asks for one on the moves where a human will later want
 * to know why (mismatch, clearing a flagged duplicate).
 */
export function PaymentVerifySheet({
  open,
  onOpenChange,
  target,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PaymentVerificationState | null;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  if (!target) return null;

  const trimmed = reason.trim();

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(`payments.actions.verify.${target}.label`)}
      description={t(`payments.actions.verify.${target}.body`)}
      snap="half"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payment-verify-reason" className="text-label text-text-secondary">
          {t("payments.actions.reasonOptional")}
        </Label>
        <Input
          id="payment-verify-reason"
          className="h-12"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <span className="text-caption text-text-secondary">{t("payments.actions.reasonHint")}</span>
      </div>

      {error ? (
        <p className="text-caption mt-3 text-status-danger-text" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        className="tap-target mt-5 h-12 w-full"
        variant={target === "mismatch" ? "destructive" : "default"}
        disabled={pending}
        onClick={() => onConfirm(trimmed.length > 0 ? trimmed : undefined)}
      >
        {pending ? t("payments.actions.working") : t(`payments.actions.verify.${target}.submit`)}
      </Button>
    </BottomSheet>
  );
}

// ── Refund ────────────────────────────────────────────────────────────────────

/**
 * Amount is typed in the PAYMENT'S OWN currency, which is fixed and shown, not
 * chosen. A refund is a return of money that already arrived in one currency;
 * offering a currency picker here would be offering an implicit conversion,
 * which ARCHITECTURE.md forbids outright.
 *
 * The field holds text, parsed once through parseMinorUnits (integer
 * arithmetic only — never `parseFloat(x) * 100`). Nothing here subtracts
 * anything from anything: how much of this payment is still refundable is
 * derived in SQL from the refund event ledger, and the server rejects an
 * amount that exceeds it.
 */
export function PaymentRefundSheet({
  open,
  onOpenChange,
  principal,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** This payment's own amount, for reference. Never used in a calculation. */
  principal: Money;
  pending: boolean;
  error: string | null;
  onConfirm: (amountMinor: number, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) {
      setAmountText("");
      setReason("");
    }
  }, [open]);

  const currency = principal.currency;
  const parsed = parseMinorUnits(amountText, currency);
  const amountValid = parsed !== null && parsed > 0;
  const trimmedReason = reason.trim();

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("payments.actions.refund.title")}
      description={t("payments.actions.refund.body")}
      snap="full"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-refund-amount" className="text-label text-text-secondary">
            {t("payments.actions.refund.amountLabel", { currency })}
          </Label>
          <Input
            id="payment-refund-amount"
            inputMode="decimal"
            className="text-financial h-12"
            placeholder={MINOR_UNIT_DIGITS[currency] === 0 ? "0" : "0.00"}
            value={amountText}
            aria-describedby="payment-refund-amount-hint"
            onChange={(event) => setAmountText(event.target.value)}
          />
          {/*
           * Read the stored value back in the merchant's own terms before
           * anything is sent, so a misplaced decimal is visible here rather
           * than in the ledger.
           */}
          {amountValid ? (
            <span className="text-data tnum text-text-muted">
              {formatMoney({ amount: parsed, currency })}
            </span>
          ) : null}
          <span id="payment-refund-amount-hint" className="text-caption text-text-secondary">
            {t("payments.actions.refund.amountHint", { amount: formatMoney(principal) })}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-refund-reason" className="text-label text-text-secondary">
            {t("payments.actions.reasonRequired")}
          </Label>
          <Input
            id="payment-refund-reason"
            className="h-12"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>

        <p className="text-caption text-text-secondary">{t("payments.actions.refund.note")}</p>

        {error ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {error}
          </p>
        ) : null}

        <Button
          className="tap-target h-12 w-full"
          variant="destructive"
          disabled={pending || !amountValid || trimmedReason.length === 0}
          onClick={() => {
            if (parsed === null) return;
            onConfirm(parsed, trimmedReason);
          }}
        >
          {pending ? t("payments.actions.working") : t("payments.actions.refund.submit")}
        </Button>
      </div>
    </BottomSheet>
  );
}

// ── Reversal ──────────────────────────────────────────────────────────────────

/** reverse_payment_v1 requires a non-empty reason; submit stays disabled without one. */
export function PaymentReverseSheet({
  open,
  onOpenChange,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const trimmed = reason.trim();

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("payments.actions.reverse.title")}
      description={t("payments.actions.reverse.body")}
      snap="half"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payment-reverse-reason" className="text-label text-text-secondary">
          {t("payments.actions.reasonRequired")}
        </Label>
        <Input
          id="payment-reverse-reason"
          className="h-12"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      <p className="text-caption mt-3 text-text-secondary">{t("payments.actions.reverse.note")}</p>

      {error ? (
        <p className="text-caption mt-3 text-status-danger-text" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        className="tap-target mt-5 h-12 w-full"
        variant="destructive"
        disabled={pending || trimmed.length === 0}
        onClick={() => onConfirm(trimmed)}
      >
        {pending ? t("payments.actions.working") : t("payments.actions.reverse.submit")}
      </Button>
    </BottomSheet>
  );
}
