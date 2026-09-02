import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, CurrencyInput } from "@/design-system";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Courier, Money, PaymentMethod } from "@/types";

const METHODS: PaymentMethod[] = ["cash", "khqr", "bank_transfer", "cod"];

function MethodChips({
  value,
  onChange,
  label,
}: {
  value: PaymentMethod;
  onChange: (m: PaymentMethod) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="mt-4">
      <legend className="text-label text-text-secondary">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {METHODS.map((method) => (
          <button
            key={method}
            type="button"
            aria-pressed={value === method}
            onClick={() => onChange(method)}
            className={cn(
              "tap-target text-label chip-text rounded-full border px-4",
              value === method
                ? "border-action-primary bg-action-primary text-text-inverse"
                : "border-border-default bg-surface-primary text-text-secondary",
            )}
          >
            {t(`pos.method.${method}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function RecordPaymentSheet({
  open,
  onOpenChange,
  balance,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: Money;
  onConfirm: (input: { method: PaymentMethod; amountCents: number; reference: string }) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<PaymentMethod>("khqr");
  const [amount, setAmount] = useState(Math.max(0, balance.amount));
  const [reference, setReference] = useState("");

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={t("order.paymentSheet.title")} snap="full">
      <p className="text-body-sm text-text-secondary">{t("order.paymentSheet.body")}</p>
      <CurrencyInput
        className="mt-4"
        id="record-payment-amount"
        label={t("order.paymentSheet.amount")}
        value={amount}
        onChange={setAmount}
      />
      <MethodChips value={method} onChange={setMethod} label={t("order.paymentSheet.method")} />
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="payment-reference" className="text-label text-text-secondary">
          {t("order.paymentSheet.reference")}
        </Label>
        <Input
          id="payment-reference"
          className="h-12"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <Button
        className="tap-target mt-5 h-12 w-full"
        disabled={pending || amount <= 0}
        onClick={() => onConfirm({ method, amountCents: amount, reference })}
      >
        {t("order.paymentSheet.submit")}
      </Button>
    </BottomSheet>
  );
}

export function ReturnSheet({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { reason: string; restock: boolean }) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={t("order.returnSheet.title")} snap="half">
      <p className="text-body-sm text-text-secondary">{t("order.returnSheet.body")}</p>
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="return-reason" className="text-label text-text-secondary">
          {t("order.returnSheet.reason")}
        </Label>
        <Input
          id="return-reason"
          className="h-12"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={restock}
        onClick={() => setRestock((v) => !v)}
        className="tap-target text-body-sm mt-4 flex w-full items-center justify-between rounded-xl border border-border-default px-4 text-text-primary"
      >
        <span>{t("order.returnSheet.restock")}</span>
        <span
          aria-hidden
          className={cn(
            "text-caption chip-text rounded-full px-2 py-0.5",
            restock ? "bg-status-success-soft text-status-success-text" : "bg-surface-secondary text-text-secondary",
          )}
        >
          {restock ? "✓" : "—"}
        </span>
      </button>
      <Button
        className="tap-target mt-5 h-12 w-full"
        disabled={pending}
        onClick={() => onConfirm({ reason, restock })}
      >
        {t("order.returnSheet.submit")}
      </Button>
    </BottomSheet>
  );
}

export function RefundSheet({
  open,
  onOpenChange,
  total,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: Money;
  onConfirm: (input: { amountCents: number; method: PaymentMethod; reason: string }) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(total.amount);
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [reason, setReason] = useState("");

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={t("order.refundSheet.title")} snap="full">
      <p className="text-body-sm text-text-secondary">{t("order.refundSheet.body")}</p>
      <CurrencyInput
        className="mt-4"
        id="refund-amount"
        label={t("order.refundSheet.amount")}
        value={amount}
        onChange={setAmount}
      />
      <MethodChips value={method} onChange={setMethod} label={t("order.refundSheet.method")} />
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="refund-reason" className="text-label text-text-secondary">
          {t("order.refundSheet.reason")}
        </Label>
        <Input
          id="refund-reason"
          className="h-12"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-body-sm mt-3 text-status-danger-text">
          {error}
        </p>
      ) : null}
      <Button
        className="tap-target mt-5 h-12 w-full"
        disabled={pending}
        onClick={() => onConfirm({ amountCents: amount, method, reason })}
      >
        {t("order.refundSheet.submit")}
      </Button>
    </BottomSheet>
  );
}

export function ArrangeDeliverySheet({
  open,
  onOpenChange,
  couriers,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  couriers: Courier[];
  onConfirm: (courierId: string) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [courierId, setCourierId] = useState(couriers[0]?.id ?? "");

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={t("order.deliverySheet.title")} snap="half">
      <p className="text-body-sm text-text-secondary">{t("order.deliverySheet.body")}</p>
      <div className="mt-4 space-y-2">
        {couriers.map((courier) => (
          <button
            key={courier.id}
            type="button"
            aria-pressed={courierId === courier.id}
            onClick={() => setCourierId(courier.id)}
            className={cn(
              "tap-target flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left",
              courierId === courier.id
                ? "border-action-primary bg-action-primary-soft"
                : "border-border-default bg-surface-primary",
            )}
          >
            <span className="text-body-sm text-text-primary">{courier.name}</span>
            <span className="text-financial text-text-secondary">{formatMoney(courier.fee)}</span>
          </button>
        ))}
      </div>
      <Button
        className="tap-target mt-5 h-12 w-full"
        disabled={pending || !courierId}
        onClick={() => onConfirm(courierId)}
      >
        {t("order.deliverySheet.submit")}
      </Button>
    </BottomSheet>
  );
}
