import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { customers } from "@/lib/mock/customers";
import { conversations } from "@/lib/mock/conversations";
import { homeSummaries } from "@/lib/mock/home";
import { staff } from "@/lib/mock/shop";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { khr, usd } from "@/lib/money";
import {
  ApsiIllustration,
  ApsiInsightCard,
  AttentionCard,
  BottomNav,
  BottomSheet,
  ChannelBadge,
  ConversationRow,
  CurrencyInput,
  CustomerSummaryCard,
  EmptyState,
  ErrorState,
  LanguageToggle,
  ListSkeleton,
  MessageBubble,
  MetricTile,
  Money,
  QuantityStepper,
  QuickActionGrid,
  StatusChip,
} from "@/design-system";
import type { StatusKey } from "@/types";

export const Route = createFileRoute("/design")({
  head: () => ({
    meta: [
      { title: "Design system — APSA" },
      {
        name: "description",
        content: "APSA design tokens, typography, motion and every component in every state.",
      },
      { property: "og:title", content: "Design system — APSA" },
      {
        property: "og:description",
        content: "Colour tokens, type scale, and the full APSA component library with all states.",
      },
    ],
  }),
  component: DesignReference,
});

const ALL_STATUSES: StatusKey[] = [
  "unread",
  "needs_reply",
  "follow_up",
  "waiting_customer",
  "order_created",
  "closed",
  "pending_payment",
  "paid",
  "failed",
  "refunded",
  "confirmed",
  "packing",
  "ready",
  "in_transit",
  "delivered",
  "cancelled",
  "returned",
  "low_stock",
  "out_of_stock",
];

const TOKEN_GROUPS: { name: string; vars: string[] }[] = [
  {
    name: "Brand & action",
    vars: ["--brand-primary", "--action-primary", "--action-primary-hover", "--action-primary-soft"],
  },
  {
    name: "Surface",
    vars: ["--surface-primary", "--surface-secondary", "--surface-elevated", "--surface-sunken"],
  },
  {
    name: "Status",
    vars: ["--status-success", "--status-warning", "--status-danger", "--status-info"],
  },
  {
    name: "Channel",
    vars: ["--channel-facebook", "--channel-instagram", "--channel-telegram", "--channel-pos"],
  },
  {
    name: "Companion",
    vars: [
      "--companion-nilo",
      "--companion-minto",
      "--companion-vela",
      "--companion-suri",
      "--companion-luma",
    ],
  },
];

const TYPE_SCALE = [
  "text-display",
  "text-h1",
  "text-h2",
  "text-h3",
  "text-body",
  "text-body-sm",
  "text-label",
  "text-caption",
  "text-financial-lg",
  "text-financial",
  "text-data",
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border-default px-5 py-8">
      <div className="mx-auto w-full max-w-3xl">
        <h2 className="text-h2 mb-4 text-text-primary">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function DesignReference() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [qty, setQty] = useState(2);
  const [cents, setCents] = useState(1980);
  const [sheetOpen, setSheetOpen] = useState(false);

  const customer = customers[0]!;
  const conversation = conversations[0]!;

  return (
    <div className="min-h-screen bg-surface-primary pb-32 text-text-primary lg:pb-24">
      <header className="px-5 py-8">
        <div className="mx-auto flex w-full max-w-3xl items-start gap-3">
          <div className="flex-1">
            <h1 className="text-h1">{t("design.title")}</h1>
            <p className="text-body mt-2 text-text-secondary">{t("design.subtitle")}</p>
          </div>
          <LanguageToggle className="text-text-secondary" />
        </div>
      </header>

      <Block title={t("design.colours")}>
        <div className="space-y-5">
          {TOKEN_GROUPS.map((group) => (
            <div key={group.name}>
              <p className="text-label mb-2 text-text-secondary">{group.name}</p>
              <div className="flex flex-wrap gap-3">
                {group.vars.map((token) => (
                  <div key={token} className="w-28">
                    <div
                      className="h-12 w-full rounded-xl border border-border-default"
                      style={{ backgroundColor: `var(${token})` }}
                    />
                    <p className="text-caption mt-1 break-all text-text-muted">{token}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Block>

      <Block title={t("design.typography")}>
        <ul className="space-y-3">
          {TYPE_SCALE.map((cls) => (
            <li key={cls} className="flex items-baseline gap-4">
              <span className="text-caption w-32 shrink-0 text-text-muted">{cls}</span>
              <span className={cls}>អាជីវកម្មរបស់អ្នក · Your business 1234</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title={t("design.money")}>
        <div className="flex flex-wrap items-start gap-6">
          <Money value={usd(1980)} showSecondary size="lg" />
          <Money value={khr(81000)} />
          <Money value={usd(129805)} showSecondary size="sm" />
          <CurrencyInput value={cents} onChange={setCents} className="w-52" />
        </div>
      </Block>

      <Block title="Status">
        <div className="flex flex-wrap gap-2">
          {ALL_STATUSES.map((status) => (
            <StatusChip key={status} status={status} size="md" />
          ))}
        </div>
      </Block>

      <Block title="Channels">
        <div className="flex flex-wrap gap-4">
          {(["facebook", "instagram", "telegram", "pos"] as const).map((channel) => (
            <ChannelBadge key={channel} channel={channel} withLabel />
          ))}
        </div>
      </Block>

      <Block title="Apsi">
        <div className="flex flex-wrap items-end gap-4">
          {(["default", "waving", "winking", "typing", "merging"] as const).map((pose) => (
            <div key={pose} className="text-center">
              <ApsiIllustration pose={pose} size={72} />
              <p className="text-caption mt-1 text-text-muted">{pose}</p>
            </div>
          ))}
        </div>
        <ApsiInsightCard
          className="mt-5"
          title={t("home.apsi.title")}
          body={t("home.apsi.body")}
          onDismiss={() => undefined}
        />
      </Block>

      <Block title={t("design.components")}>
        <div className="space-y-6">
          <div className="overflow-hidden rounded-2xl border border-border-default">
            <ConversationRow
              conversation={conversation}
              customerName={localName(customer, language)}
              companion={customer.companion}
              assignedStaff={staff[0]}
            />
          </div>

          <div className="space-y-2 rounded-2xl border border-border-default p-4">
            <MessageBubble
              message={{ id: "m1", direction: "inbound", body: "មានពណ៌ខ្មៅ size M អត់?", at: new Date().toISOString() }}
            />
            <MessageBubble
              message={{
                id: "m2",
                direction: "outbound",
                body: "មាន​បង! តម្លៃ $19.80",
                at: new Date().toISOString(),
                state: "read",
              }}
            />
            <MessageBubble
              message={{ id: "m3", direction: "system", body: "Order APSA-0143 created", at: new Date().toISOString() }}
            />
          </div>

          <CustomerSummaryCard customer={customer} displayName={localName(customer, language)} onViewProfile={() => undefined} />

          <div className="grid grid-cols-2 gap-2">
            {homeSummaries.today.metrics.map((metric) => (
              <MetricTile
                key={metric.id}
                label={t(`home.metrics.${metric.id}`)}
                value={metric.value}
                deltaPercent={metric.deltaPercent}
                series={metric.series}
              />
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {homeSummaries.today.attention.map((item) => (
              <AttentionCard key={item.id} item={item} />
            ))}
          </div>

          <QuickActionGrid />

          <div className="flex flex-wrap items-center gap-4">
            <QuantityStepper value={qty} onChange={setQty} />
            <Button className="tap-target" onClick={() => setSheetOpen(true)}>
              {t("design.openSheet")}
            </Button>
          </div>
        </div>
      </Block>

      <Block title={t("design.states")}>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-border-default">
            <ListSkeleton rows={3} />
          </div>
          <div className="rounded-2xl border border-border-default">
            <EmptyState title={t("empty.title")} body={t("empty.body")} />
          </div>
          <div className="rounded-2xl border border-border-default">
            <ErrorState onRetry={() => undefined} />
          </div>
        </div>
      </Block>

      <Block title={t("design.motion")}>
        <p className="text-body text-text-secondary">
          Sheets and overlays move at 240ms on a decelerating curve. Reduced motion removes travel
          and keeps opacity only.
        </p>
      </Block>

      <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen} title={t("design.sheetTitle")}>
        <p className="text-body text-text-secondary">{t("design.sheetBody")}</p>
      </BottomSheet>

      <BottomNav workspace="business" />
    </div>
  );
}
