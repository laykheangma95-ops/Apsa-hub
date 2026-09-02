import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Banknote,
  Check,
  Languages,
  MessageSquare,
  Package,
  QrCode,
  Truck,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ApsiIllustration, ChannelBadge, LanguageToggle, StatusChip } from "@/design-system";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "APSA — One inbox for every Cambodian seller" },
      {
        name: "description",
        content:
          "APSA connects messages, customers, orders, payments, stock and delivery into one flow for Cambodian social-commerce sellers.",
      },
      { property: "og:title", content: "APSA — One inbox for every Cambodian seller" },
      {
        property: "og:description",
        content:
          "Messages, customers, orders, payments, stock and delivery in one connected flow. Khmer first, KHQR ready.",
      },
    ],
  }),
  component: Landing,
});

function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`px-5 py-14 md:py-20 ${className}`}>
      <div className="mx-auto w-full max-w-5xl">{children}</div>
    </section>
  );
}

function Landing() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-surface-primary text-text-primary">
      <header className="sticky top-0 z-30 border-b border-border-default bg-surface-primary/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-5">
          <span className="text-h3 flex-1 text-action-primary">{t("brand.name")}</span>
          <nav className="hidden items-center gap-5 md:flex" aria-label={t("brand.name")}>
            <a href="#product" className="text-label text-text-secondary">
              {t("landing.nav.product")}
            </a>
            <a href="#workflow" className="text-label text-text-secondary">
              {t("landing.nav.workflow")}
            </a>
            <a href="#cambodia" className="text-label text-text-secondary">
              {t("landing.nav.cambodia")}
            </a>
          </nav>
          <LanguageToggle className="text-text-secondary" />
          <Button asChild size="sm" className="tap-target">
            <Link to="/app">{t("landing.nav.start")}</Link>
          </Button>
        </div>
      </header>

      {/* Gradient location 1 of 2: hero */}
      <section className="gradient-brand px-5 pt-14 pb-16 text-text-inverse">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 md:grid-cols-2">
          <div>
            <h1 className="text-display">{t("landing.hero.title")}</h1>
            <p className="text-body mt-4 max-w-md opacity-90">{t("landing.hero.subtitle")}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg" variant="secondary" className="tap-target">
                <Link to="/app">{t("landing.hero.primary")}</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="tap-target border-current/40 bg-transparent text-text-inverse hover:bg-white/10"
              >
                <a href="#workflow">{t("landing.hero.secondary")}</a>
              </Button>
            </div>
          </div>

          <div className="rounded-3xl bg-surface-primary p-4 text-text-primary shadow-xl">
            <ul className="space-y-2.5">
              {[
                { icon: MessageSquare, label: t("landing.hero.demoMessage") },
                { icon: Users, label: t("landing.hero.demoCustomer") },
                { icon: Package, label: t("landing.hero.demoOrder") },
                { icon: Banknote, label: t("landing.hero.demoPaid") },
                { icon: Truck, label: t("landing.hero.demoTransit") },
                { icon: Package, label: t("landing.hero.demoStock") },
              ].map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="flex items-center gap-3 rounded-xl border border-border-default px-3 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-action-primary-soft text-action-primary">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="text-body-sm">{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <Section id="product" className="bg-surface-secondary">
        <h2 className="text-h1">{t("landing.problem.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.problem.body")}</p>
        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-4 py-3">
          <ApsiIllustration pose="merging" size={44} />
          <p className="text-label">{t("landing.problem.result")}</p>
        </div>
      </Section>

      <Section>
        <div className="grid gap-8 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-h1">{t("landing.inbox.title")}</h2>
            <p className="text-body mt-3 text-text-secondary">{t("landing.inbox.body")}</p>
          </div>
          <ul className="divide-y divide-border-default overflow-hidden rounded-2xl border border-border-default">
            {(["facebook", "instagram", "telegram"] as const).map((channel, i) => (
              <li key={channel} className="flex items-center gap-3 bg-surface-primary px-4 py-3">
                <ChannelBadge channel={channel} withLabel />
                <span className="flex-1" />
                <StatusChip status={i === 0 ? "unread" : i === 1 ? "needs_reply" : "follow_up"} />
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="workflow" className="bg-surface-secondary">
        <h2 className="text-h1">{t("landing.flow.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.flow.body")}</p>
        <ol className="mt-6 grid gap-3 md:grid-cols-3">
          {[t("landing.flow.step1"), t("landing.flow.step2"), t("landing.flow.step3")].map(
            (step, i) => (
              <li
                key={step}
                className="rounded-2xl border border-border-default bg-surface-primary p-4"
              >
                <span className="text-financial text-action-primary">{i + 1}</span>
                <p className="text-body-sm mt-1 text-text-secondary">{step}</p>
              </li>
            ),
          )}
        </ol>
      </Section>

      <Section>
        <h2 className="text-h1">{t("landing.ops.title")}</h2>
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {[
            { title: t("landing.ops.orders"), body: t("landing.ops.ordersBody"), icon: Package },
            { title: t("landing.ops.payment"), body: t("landing.ops.paymentBody"), icon: Banknote },
            { title: t("landing.ops.delivery"), body: t("landing.ops.deliveryBody"), icon: Truck },
          ].map(({ title, body, icon: Icon }) => (
            <article key={title} className="rounded-2xl border border-border-default p-4">
              <span className="flex size-9 items-center justify-center rounded-xl bg-action-primary-soft text-action-primary">
                <Icon className="size-4" aria-hidden />
              </span>
              <h3 className="text-h3 mt-3">{title}</h3>
              <p className="text-body-sm mt-1 text-text-secondary">{body}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section className="bg-surface-secondary">
        <div className="grid gap-8 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-h1">{t("landing.history.title")}</h2>
            <p className="text-body mt-3 text-text-secondary">{t("landing.history.body")}</p>
          </div>
          <div className="rounded-2xl border border-border-default bg-surface-primary p-4">
            <ul className="space-y-2">
              {["M · black", "Toul Kork", "$19.80 · 12 Feb", "Prefers Telegram"].map((line) => (
                <li key={line} className="text-body-sm flex items-center gap-2 text-text-secondary">
                  <Check className="size-4 text-status-success" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="cambodia">
        <h2 className="text-h1">{t("landing.cambodia.title")}</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          {[
            { title: t("landing.cambodia.khqr"), body: t("landing.cambodia.khqrBody"), icon: QrCode },
            {
              title: t("landing.cambodia.currency"),
              body: t("landing.cambodia.currencyBody"),
              icon: Banknote,
            },
            {
              title: t("landing.cambodia.couriers"),
              body: t("landing.cambodia.couriersBody"),
              icon: Truck,
            },
            {
              title: t("landing.cambodia.khmer"),
              body: t("landing.cambodia.khmerBody"),
              icon: Languages,
            },
          ].map(({ title, body, icon: Icon }) => (
            <article key={title} className="rounded-2xl border border-border-default p-4">
              <Icon className="size-5 text-action-primary" aria-hidden />
              <h3 className="text-h3 mt-3">{title}</h3>
              <p className="text-body-sm mt-1 text-text-secondary">{body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* Gradient location 2 of 2: closing CTA */}
      <section className="gradient-brand px-5 py-16 text-text-inverse">
        <div className="mx-auto w-full max-w-3xl text-center">
          <h2 className="text-h1">{t("landing.cta.title")}</h2>
          <p className="text-body mt-3 opacity-90">{t("landing.cta.body")}</p>
          <Button asChild size="lg" variant="secondary" className="tap-target mt-6">
            <Link to="/app">
              {t("landing.cta.action")}
              <ArrowRight className="ml-1 size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border-default px-5 py-10">
        <div className="mx-auto grid w-full max-w-5xl gap-8 sm:grid-cols-4">
          <div>
            <p className="text-h3 text-action-primary">{t("brand.name")}</p>
            <p className="text-body-sm mt-1 text-text-secondary">{t("brand.tagline")}</p>
          </div>
          <FooterColumn
            title={t("landing.footer.product")}
            items={[
              t("landing.footer.inbox"),
              t("landing.footer.orders"),
              t("landing.footer.pos"),
              t("landing.footer.delivery"),
            ]}
          />
          <FooterColumn
            title={t("landing.footer.company")}
            items={[
              t("landing.footer.about"),
              t("landing.footer.careers"),
              t("landing.footer.contact"),
            ]}
          />
          <FooterColumn
            title={t("landing.footer.support")}
            items={[
              t("landing.footer.help"),
              t("landing.footer.privacy"),
              t("landing.footer.terms"),
            ]}
          />
        </div>
        <p className="text-caption mx-auto mt-8 w-full max-w-5xl text-text-muted">
          © {new Date().getFullYear()} {t("landing.footer.rights")}
        </p>
      </footer>
    </div>
  );
}

function FooterColumn({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-label">{title}</p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="text-body-sm text-text-secondary">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
