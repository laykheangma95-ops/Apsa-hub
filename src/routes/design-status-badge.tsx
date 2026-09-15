import { createFileRoute } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import i18n from "@/lib/i18n";
import { StatusBadge, type StatusBadgeKey } from "@/design-system";

/**
 * Internal, dev-only QA page for the StatusBadge system (APSA Status System
 * reference). Sits next to /design and /design-mascot; it is not linked from
 * any production surface and integrates nothing. Delete or promote after QA.
 *
 * Renders every reference state in both variants, all three sizes, both
 * languages, on porcelain and on a dark surface, plus a mobile-width strip.
 */

export const Route = createFileRoute("/design-status-badge")({
  head: () => ({
    meta: [
      { title: "StatusBadge QA — APSA" },
      {
        name: "description",
        content:
          "Internal preview of all 22 reference status badges: glass and flat, sm/md/lg, English and Khmer.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: StatusBadgeReference,
});

/** The 22 states from the APSA Status System reference (mirrors src/tests/status-badge.test.ts). */
const REFERENCE_STATUSES: StatusBadgeKey[] = [
  "synced",
  "connected",
  "new_message",
  "needs_reply",
  "ai_suggested",
  "in_review",
  "approved",
  "pending",
  "pending_payment",
  "paid",
  "cod_pending",
  "processing",
  "scheduled",
  "in_delivery",
  "delivered",
  "completed",
  "refunded",
  "cancelled",
  "failed",
  "archived",
  "low_stock",
  "paused",
];

const SIZES = ["sm", "md", "lg"] as const;
type BadgeSize = (typeof SIZES)[number];

/*
 * Fixed-language instances so English and Khmer badges render side-by-side
 * regardless of the app language. cloneInstance shares the resource store;
 * it only pins `lng` for its own subtree.
 */
const enI18n = i18n.cloneInstance({ lng: "en" });
const kmI18n = i18n.cloneInstance({ lng: "km" });

/** Visual neighbours a QA pass should confirm stay distinguishable. */
const SIMILAR_GROUPS: StatusBadgeKey[][] = [
  ["pending", "pending_payment", "cod_pending"],
  ["approved", "paid", "delivered", "completed"],
  ["cancelled", "failed", "low_stock"],
  ["connected", "in_review", "in_delivery", "paused"],
  ["refunded", "completed"],
];

function Section({
  title,
  note,
  children,
  dark = false,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <section
      className="border-t px-5 py-8"
      style={{
        borderColor: dark ? "rgba(255,255,255,0.16)" : "var(--border-default)",
        backgroundColor: dark ? "var(--surface-inverse)" : "transparent",
      }}
    >
      <div className="mx-auto w-full max-w-3xl">
        <h2
          className="text-h2 mb-1"
          style={{ color: dark ? "var(--text-inverse)" : "var(--text-primary)" }}
        >
          {title}
        </h2>
        {note ? (
          <p
            className="text-body-sm mb-4"
            style={{ color: dark ? "rgba(255,255,255,0.72)" : "var(--text-secondary)" }}
          >
            {note}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

function StatusRow({ status, variant }: { status: StatusBadgeKey; variant: "glass" | "flat" }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <code className="text-caption w-36 shrink-0 text-text-muted">{status}</code>
      {SIZES.map((size) => (
        <div key={size} className="flex w-32 items-center">
          <StatusBadge status={status} variant={variant} size={size} />
        </div>
      ))}
    </div>
  );
}

function StatusTable({
  statuses,
  variant,
  dark = false,
}: {
  statuses: StatusBadgeKey[];
  variant: "glass" | "flat";
  dark?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="text-caption w-36 shrink-0" />
        {SIZES.map((size: BadgeSize) => (
          <span
            key={size}
            className="text-caption w-32"
            style={{ color: dark ? "rgba(255,255,255,0.6)" : "var(--text-muted)" }}
          >
            {size}
          </span>
        ))}
      </div>
      {statuses.map((status) => (
        <StatusRow key={status} status={status} variant={variant} />
      ))}
    </div>
  );
}

function StatusBadgeReference() {
  /*
   * The app sets data-lang="km" on <html>, and [data-lang="km"] .chip-text
   * outranks a bare .chip-text rule — so on this page the Khmer no-ellipsis
   * override would win for English badges too. In a real English session the
   * document itself carries data-lang="en" and the base styles.css rule
   * applies. These two QA-only rules simulate that document state: the first
   * pins single-line ellipsis inside the English page root, the second keeps
   * Khmer sections wrapping naturally inside their data-lang="km" wrappers.
   * Nothing here ships beyond this preview route.
   */
  return (
    <div
      data-lang="en"
      className="qa-status-badge min-h-screen pb-24"
      style={{ backgroundColor: "var(--brand-porcelain)", color: "var(--text-primary)" }}
    >
      <style>{`
        .qa-status-badge .chip-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qa-status-badge [data-lang="km"] .chip-text {
          overflow: visible;
          text-overflow: clip;
          white-space: normal;
        }
      `}</style>
      <header className="px-5 py-8">
        <div className="mx-auto w-full max-w-3xl">
          <p className="text-caption mb-1 text-text-muted">
            Internal · dev-only preview — not linked from any production screen
          </p>
          <h1 className="text-h1">StatusBadge QA</h1>
          <p className="text-body mt-2 max-w-xl text-text-secondary">
            All 22 states from the APSA Status System reference, in glass and flat variants, sm / md
            / lg sizes, English and Khmer, on porcelain and on a dark surface. QA focus: contrast,
            icon alignment, truncation, Khmer fit, spacing, border consistency, glass blur/shadow
            balance, and semantic distinction between similar states.
          </p>
        </div>
      </header>

      <I18nextProvider i18n={enI18n}>
        <Section title="Glass — English" note="Liquid-glass pill on porcelain.">
          <StatusTable statuses={REFERENCE_STATUSES} variant="glass" />
        </Section>
      </I18nextProvider>

      <I18nextProvider i18n={enI18n}>
        <Section title="Flat — English" note="Solid soft-fill pill, no glass blur.">
          <StatusTable statuses={REFERENCE_STATUSES} variant="flat" />
        </Section>
      </I18nextProvider>

      {/* data-lang="km" reproduces the production Khmer rendering rules (no ellipsis truncation). */}
      <I18nextProvider i18n={kmI18n}>
        <div data-lang="km">
          <Section title="Glass — Khmer" note="ខ្មែរ · liquid-glass pill on porcelain.">
            <StatusTable statuses={REFERENCE_STATUSES} variant="glass" />
          </Section>
        </div>
      </I18nextProvider>

      <I18nextProvider i18n={kmI18n}>
        <div data-lang="km">
          <Section title="Flat — Khmer" note="ខ្មែរ · solid soft-fill pill, no glass blur.">
            <StatusTable statuses={REFERENCE_STATUSES} variant="flat" />
          </Section>
        </div>
      </I18nextProvider>

      {/*
       * No dark theme token block exists yet (styles.css reserves one), so the
       * badges keep their light-theme tokens here — this strip previews exactly
       * that combination: light tokens on --surface-inverse.
       */}
      <Section
        dark
        title="Dark surface"
        note="Light-theme tokens on --surface-inverse (#1b2b59). md size, both variants and languages — check contrast and glass shadow balance."
      >
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
            <div>
              <p className="text-caption mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>
                glass · English
              </p>
              <I18nextProvider i18n={enI18n}>
                <div className="flex flex-wrap gap-2">
                  {REFERENCE_STATUSES.map((status) => (
                    <StatusBadge key={status} status={status} variant="glass" size="md" />
                  ))}
                </div>
              </I18nextProvider>
            </div>
            <div>
              <p className="text-caption mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>
                flat · English
              </p>
              <I18nextProvider i18n={enI18n}>
                <div className="flex flex-wrap gap-2">
                  {REFERENCE_STATUSES.map((status) => (
                    <StatusBadge key={status} status={status} variant="flat" size="md" />
                  ))}
                </div>
              </I18nextProvider>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
            <div>
              <p className="text-caption mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>
                glass · Khmer
              </p>
              <I18nextProvider i18n={kmI18n}>
                <div data-lang="km" className="flex flex-wrap gap-2">
                  {REFERENCE_STATUSES.map((status) => (
                    <StatusBadge key={status} status={status} variant="glass" size="md" />
                  ))}
                </div>
              </I18nextProvider>
            </div>
            <div>
              <p className="text-caption mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>
                flat · Khmer
              </p>
              <I18nextProvider i18n={kmI18n}>
                <div data-lang="km" className="flex flex-wrap gap-2">
                  {REFERENCE_STATUSES.map((status) => (
                    <StatusBadge key={status} status={status} variant="flat" size="md" />
                  ))}
                </div>
              </I18nextProvider>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Mobile width · 360px"
        note="Compact strip at a typical small-phone width. Badges wrap; watch label fit, spacing and icon alignment when a row breaks."
      >
        <div
          className="mx-auto overflow-hidden rounded-2xl border p-3"
          style={{
            width: 360,
            maxWidth: "100%",
            borderColor: "var(--border-default)",
            backgroundColor: "var(--surface-primary)",
          }}
        >
          <I18nextProvider i18n={enI18n}>
            <div className="flex flex-wrap gap-2">
              {REFERENCE_STATUSES.map((status) => (
                <StatusBadge key={status} status={status} variant="glass" size="sm" />
              ))}
            </div>
          </I18nextProvider>
          <I18nextProvider i18n={kmI18n}>
            <div data-lang="km" className="mt-3 flex flex-wrap gap-2">
              {REFERENCE_STATUSES.map((status) => (
                <StatusBadge key={status} status={status} variant="flat" size="sm" />
              ))}
            </div>
          </I18nextProvider>
        </div>
      </Section>

      <Section
        title="Fit / truncation probe"
        note="Each badge sits in a fixed 112px cell — the narrow slots an order card or inbox row actually offers. English should ellipsis; Khmer must never be clipped mid-word."
      >
        <div className="space-y-3">
          <I18nextProvider i18n={enI18n}>
            <div className="flex flex-wrap gap-2">
              {REFERENCE_STATUSES.map((status) => (
                <div
                  key={status}
                  className="w-28 overflow-hidden rounded-lg border border-dashed p-1"
                  style={{ borderColor: "var(--border-strong)" }}
                >
                  <StatusBadge status={status} variant="glass" size="md" />
                </div>
              ))}
            </div>
          </I18nextProvider>
          <I18nextProvider i18n={kmI18n}>
            <div data-lang="km" className="flex flex-wrap gap-2">
              {REFERENCE_STATUSES.map((status) => (
                <div
                  key={status}
                  className="w-28 overflow-hidden rounded-lg border border-dashed p-1"
                  style={{ borderColor: "var(--border-strong)" }}
                >
                  <StatusBadge status={status} variant="flat" size="md" />
                </div>
              ))}
            </div>
          </I18nextProvider>
        </div>
      </Section>

      <Section
        title="Similar-state groups"
        note="States that share a tone (and sometimes an icon). Confirm each stays semantically distinct at sm size, on both backgrounds."
      >
        <div className="space-y-3">
          {SIMILAR_GROUPS.map((group) => (
            <div key={group.join(",")} className="flex flex-wrap items-center gap-2">
              <code className="text-caption w-36 shrink-0 text-text-muted">
                {group.length} × same tone
              </code>
              <I18nextProvider i18n={enI18n}>
                {group.map((status) => (
                  <StatusBadge key={status} status={status} variant="glass" size="sm" />
                ))}
              </I18nextProvider>
              <I18nextProvider i18n={kmI18n}>
                <div data-lang="km" className="contents">
                  {group.map((status) => (
                    <StatusBadge key={status} status={status} variant="glass" size="sm" />
                  ))}
                </div>
              </I18nextProvider>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
