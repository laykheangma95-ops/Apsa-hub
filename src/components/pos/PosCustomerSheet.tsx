import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, ErrorState, ListSkeleton } from "@/design-system";
import { PosNotice } from "@/components/pos/PosNotice";
import { createQuickCustomer, searchCustomers } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import type { Customer } from "@/types";

interface PosCustomerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (customer: Customer) => void;
}

export function PosCustomerSheet({ open, onOpenChange, onSelect }: PosCustomerSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  const customersQuery = useQuery({
    queryKey: ["pos-customers", query],
    queryFn: () => searchCustomers(query),
    enabled: open,
  });

  const results = customersQuery.data ?? [];

  async function quickCreate() {
    if (!name.trim() || !phone.trim()) return;
    setSaving(true);
    const customer = await createQuickCustomer({ name: name.trim(), phone: phone.trim() });
    setSaving(false);
    setCreating(false);
    setName("");
    setPhone("");
    onSelect(customer);
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("pos.customer.title")}
      snap="full"
      className="lg:max-w-[480px]"
    >
      {creating ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-cust-name" className="text-label text-text-secondary">
              {t("pos.customer.name")}
            </Label>
            <Input
              id="pos-cust-name"
              className="h-12"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-cust-phone" className="text-label text-text-secondary">
              {t("pos.customer.phone")}
            </Label>
            <Input
              id="pos-cust-phone"
              inputMode="tel"
              className="h-12"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="tap-target flex-1" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              className="tap-target flex-1"
              disabled={saving || !name.trim() || !phone.trim()}
              onClick={() => void quickCreate()}
            >
              {t("pos.customer.save")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            aria-label={t("pos.customer.search")}
            placeholder={t("pos.customer.search")}
            className="h-12"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {customersQuery.isPending ? <ListSkeleton rows={3} /> : null}
          {customersQuery.isError ? (
            <ErrorState onRetry={() => void customersQuery.refetch()} />
          ) : null}

          {!customersQuery.isPending && !customersQuery.isError && results.length === 0 ? (
            <PosNotice
              title={t("pos.customer.empty.title")}
              body={t("pos.customer.empty.body")}
            />
          ) : null}

          {results.length > 0 ? (
            <>
              <p className="text-label text-text-secondary">
                {query ? t("pos.customer.results") : t("pos.customer.recent")}
              </p>
              <ul className="divide-y divide-border-default">
                {results.map((customer) => (
                  <li key={customer.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(customer)}
                      className="tap-target flex w-full flex-col items-start py-3 text-left"
                    >
                      <span className="text-body text-text-primary">
                        {localName(customer, language)}
                      </span>
                      <span className="text-caption text-text-secondary">{customer.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <Button variant="outline" className="tap-target w-full" onClick={() => setCreating(true)}>
            {t("pos.customer.quickCreate")}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
