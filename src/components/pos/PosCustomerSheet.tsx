import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, ErrorState, ListSkeleton } from "@/design-system";
import { PosNotice } from "@/components/pos/PosNotice";
import { useCapabilities } from "@/hooks/use-capabilities";
import { createQuickCustomer, searchRealCustomers } from "@/lib/api";
import { customerKeys, visibleCustomerPhone } from "@/lib/customers-query";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import type { Customer } from "@/types";

interface PosCustomerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (customer: Customer) => void;
  /**
   * The signed-in principal, from the /app route guard's server-derived
   * context. Cache identity only — searchRealCustomers() sends no organization
   * id, and the server scopes the read to the membership it resolved itself.
   */
  userId: string;
  organizationId: string;
}

export function PosCustomerSheet({
  open,
  onOpenChange,
  onSelect,
  userId,
  organizationId,
}: PosCustomerSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const capabilities = useCapabilities();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /*
   * The CURRENT grant decides this search, in all three places it can matter.
   *
   * `canSensitive`, not `can`: a phone number's mere display is the
   * disclosure, so it must not ride on a snapshot whose latest refresh failed.
   */
  const canSensitive = capabilities.canSensitive("customers.view_sensitive");

  /*
   * Customer search results carry a phone number when the member holds
   * customers.view_sensitive. Keyed on the search term alone, the results a
   * member with that grant typed were readable by the next member to open POS
   * in the same tab — including one without it. The principal now leads the
   * key, and the whole set is dropped by clearCustomerQueries.
   *
   * The grant is in the key too. Masking the displayed number is not enough on
   * its own: this entry is cached per term, so a set matched against real
   * phone numbers while the grant held would otherwise be served straight back
   * after it is revoked. Every number on screen would be blanked, yet which
   * customers came BACK for a typed fragment still answers "does a customer
   * with this number exist here?" — the exact disclosure the grant gates. A
   * different grant is a different answer, so it is a different entry.
   */
  const customersQuery = useQuery({
    queryKey: customerKeys.search(userId, organizationId, query, canSensitive),
    /*
     * The SERVER searches now (searchRealCustomers -> searchCustomersFn ->
     * src/server/customers/service.ts). This used to fetch one bounded page of
     * the customer list and filter it in the browser, which meant a real
     * customer past that page was reported to the cashier as "no customers
     * found" while the caller was standing at the counter.
     *
     * `canSensitive` is still passed, and not as an access decision: the
     * server re-derives the grant from the membership regardless. It is so a
     * phone-shaped query from a member without the grant is never SENT — see
     * searchRealCustomers' own note on why not asking beats being told no.
     */
    queryFn: () => searchRealCustomers(query, canSensitive),
    enabled: open && query.trim().length > 0,
  });

  /*
   * Masked again at render, against the same current grant. Defence in depth:
   * the search above can no longer MATCH on a hidden number, and this makes
   * sure nothing displays one either if a payload were ever served from
   * elsewhere.
   *
   * The masking happens HERE, before both the display and `onSelect`, so the
   * customer object the cart and checkout screens go on to render inherits it
   * rather than each of them needing its own check.
   */
  const page = customersQuery.data;
  const results = (page?.customers ?? []).map((customer) => ({
    ...customer,
    phone: visibleCustomerPhone(customer, canSensitive),
  }));

  /*
   * Four different things the cashier may need to be told apart, and they are
   * four different sentences. Collapsing any of them into "no customers" is
   * how a real customer gets told they are not one:
   *
   *   denied     — the typed value is a phone number and this member may not
   *                search by phone. NOTHING WAS SEARCHED, so this says nothing
   *                about whether that customer exists.
   *   error      — the search did not complete (handled by ErrorState below).
   *   incomplete — more matches exist than are shown; narrow the query.
   *   empty      — the search ran, over the whole tenant, and matched nothing.
   */
  const denied = page?.phoneSearchDenied === true;
  const incomplete = Boolean(page && (page.hasMore || page.truncated));
  const searched = query.trim().length > 0;
  /*
   * `!incomplete` is the difference between "we looked everywhere and there is
   * no such customer" and "we stopped looking before the end". The bounded
   * phone scan can return zero matches having read only part of a large
   * tenant, and "No customer found" there is a false claim the cashier repeats
   * to the person standing at the counter. That case gets boundedNoMatch.
   */
  const emptyResult =
    searched &&
    !denied &&
    !customersQuery.isPending &&
    !customersQuery.isError &&
    results.length === 0 &&
    !incomplete;

  /** Searched, matched nothing, but stopped early — a caveat, never an absence. */
  const boundedNoMatch =
    searched &&
    !denied &&
    !customersQuery.isPending &&
    !customersQuery.isError &&
    results.length === 0 &&
    incomplete;

  async function quickCreate() {
    if (!name.trim() || !phone.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const customer = await createQuickCustomer({ name: name.trim(), phone: phone.trim() });
      setCreating(false);
      setName("");
      setPhone("");
      onSelect(customer);
    } catch {
      // The customer was NOT created — say so, and leave the form filled in
      // so the cashier can retry without retyping. Letting this throw
      // uncaught left `saving` stuck true forever with no way to tell the
      // tap even registered.
      setSaveError(t("pos.customer.saveError"));
    } finally {
      setSaving(false);
    }
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
          {saveError ? (
            <p role="alert" className="text-body-sm text-status-danger-text">
              {saveError}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="tap-target flex-1"
              onClick={() => {
                setCreating(false);
                setSaveError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="tap-target flex-1"
              disabled={saving || !name.trim() || !phone.trim()}
              onClick={() => void quickCreate()}
            >
              {saving ? t("pos.customer.saving") : t("pos.customer.save")}
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

          {!searched ? (
            <PosNotice
              title={t("pos.customer.prompt.title")}
              body={t("pos.customer.prompt.body")}
            />
          ) : null}

          {searched && customersQuery.isPending ? <ListSkeleton rows={3} /> : null}
          {customersQuery.isError ? (
            <ErrorState onRetry={() => void customersQuery.refetch()} />
          ) : null}

          {denied ? (
            <PosNotice
              title={t("pos.customer.phoneDenied.title")}
              body={t("pos.customer.phoneDenied.body")}
            />
          ) : null}

          {emptyResult ? (
            <PosNotice title={t("pos.customer.empty.title")} body={t("pos.customer.empty.body")} />
          ) : null}

          {/*
           * Zero matches from a search that stopped early. Rendered INSTEAD of
           * the empty notice, never alongside it.
           */}
          {boundedNoMatch ? (
            <PosNotice
              title={t("pos.customer.bounded.title")}
              body={t("pos.customer.bounded.body")}
            />
          ) : null}

          {results.length > 0 ? (
            <>
              <p className="text-label text-text-secondary">{t("pos.customer.results")}</p>
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

          {/*
           * The completeness caveat lives OUTSIDE the results list, so it is
           * driven by what the server reported and not by whether this page
           * happened to be non-empty. With results it warns that a page is not
           * the whole answer; with none, boundedNoMatch above has already said
           * so, and this stays quiet rather than contradicting it.
           */}
          {incomplete && results.length > 0 ? (
            <p className="text-caption text-text-muted">{t("pos.customer.more")}</p>
          ) : null}

          <Button variant="outline" className="tap-target w-full" onClick={() => setCreating(true)}>
            {t("pos.customer.quickCreate")}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
