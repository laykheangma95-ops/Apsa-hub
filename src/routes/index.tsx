import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Archive,
  Banknote,
  BarChart2,
  Check,
  Clock,
  Languages,
  MessageSquare,
  Package,
  QrCode,
  ShoppingCart,
  Truck,
  User,
  Users,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ApsiIllustration, ChannelBadge, LanguageToggle, StatusChip } from "@/design-system";
import i18n from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: i18n.t("landing.head.title") },
      { name: "description", content: i18n.t("landing.head.description") },
      { property: "og:title", content: i18n.t("landing.head.ogTitle") },
      { property: "og:description", content: i18n.t("landing.head.ogDescription") },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: i18n.t("landing.head.twitterTitle") },
      { name: "twitter:description", content: i18n.t("landing.head.twitterDescription") },
    ],
  }),
  component: Landing,
});

type SecProps = React.ComponentPropsWithoutRef<"section"> & {
  children: React.ReactNode;
};

function Sec({ children, className = "", ...rest }: SecProps) {
  return (
    <section className={`px-5 py-14 md:py-20 ${className}`} {...rest}>
      <div className="mx-auto w-full max-w-5xl">{children}</div>
    </section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-label inline-block rounded-full border border-action-primary/20 bg-action-primary-soft px-3 py-1 text-action-primary">
      {children}
    </span>
  );
}

function Landing() {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const flowSteps = [
    { icon: MessageSquare, key: "step1", label: t("landing.flow.step1") },
    { icon: User, key: "step2", label: t("landing.flow.step2") },
    { icon: ShoppingCart, key: "step3", label: t("landing.flow.step3") },
    { icon: Banknote, key: "step4", label: t("landing.flow.step4") },
    { icon: Archive, key: "step5i", label: t("landing.flow.step5i") },
    { icon: Truck, key: "step5", label: t("landing.flow.step5") },
    { icon: Clock, key: "step6", label: t("landing.flow.step6") },
    { icon: BarChart2, key: "step7", label: t("landing.flow.step7") },
  ] as const;

  const opsCards = [
    {
      icon: ShoppingCart,
      title: t("landing.ops.orders"),
      body: t("landing.ops.ordersBody"),
      accent: "bg-action-primary-soft text-action-primary",
    },
    {
      icon: Banknote,
      title: t("landing.ops.payment"),
      body: t("landing.ops.paymentBody"),
      accent: "bg-companion-minto/15 text-companion-minto",
    },
    {
      icon: QrCode,
      title: t("landing.ops.pos"),
      body: t("landing.ops.posBody"),
      accent: "bg-companion-vela/15 text-companion-vela",
    },
    {
      icon: Truck,
      title: t("landing.ops.delivery"),
      body: t("landing.ops.deliveryBody"),
      accent: "bg-companion-suri/15 text-companion-suri",
    },
    {
      icon: Archive,
      title: t("landing.ops.customers"),
      body: t("landing.ops.customersBody"),
      accent: "bg-companion-luma/15 text-companion-luma",
    },
    {
      icon: Users,
      title: t("landing.ops.team"),
      body: t("landing.ops.teamBody"),
      accent: "bg-action-primary-soft text-action-primary",
    },
  ];

  const cambodiaItems = [
    { icon: QrCode, title: t("landing.cambodia.khqr"), body: t("landing.cambodia.khqrBody") },
    { icon: Banknote, title: t("landing.cambodia.currency"), body: t("landing.cambodia.currencyBody") },
    { icon: Truck, title: t("landing.cambodia.couriers"), body: t("landing.cambodia.couriersBody") },
    { icon: Languages, title: t("landing.cambodia.khmer"), body: t("landing.cambodia.khmerBody") },
  ];

  const teamRoles = [
    { title: t("landing.lteam.owner"), desc: t("landing.lteam.ownerDesc"), accent: "bg-action-primary text-text-inverse" },
    { title: t("landing.lteam.manager"), desc: t("landing.lteam.managerDesc"), accent: "bg-companion-vela/20 text-companion-vela" },
    { title: t("landing.lteam.sales"), desc: t("landing.lteam.salesDesc"), accent: "bg-companion-minto/20 text-companion-minto" },
    { title: t("landing.lteam.cashier"), desc: t("landing.lteam.cashierDesc"), accent: "bg-companion-suri/20 text-companion-suri" },
    { title: t("landing.lteam.cs"), desc: t("landing.lteam.csDesc"), accent: "bg-companion-luma/20 text-companion-luma" },
  ];

  return (
    <div className="min-h-screen bg-surface-primary text-text-primary">

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 border-b border-border-default bg-surface-primary/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-5">
          <Link to="/" className="text-h3 flex-1 font-semibold text-action-primary" aria-label={t("brand.name")}>
            {t("brand.name")}
          </Link>

          <nav className="hidden items-center gap-6 md:flex" aria-label={t("landing.nav.primaryNav")}>
            <a href="#product" className="text-label text-text-secondary transition-colors hover:text-text-primary">
              {t("landing.nav.product")}
            </a>
            <a href="#workflow" className="text-label text-text-secondary transition-colors hover:text-text-primary">
              {t("landing.nav.workflow")}
            </a>
            <a href="#cambodia" className="text-label text-text-secondary transition-colors hover:text-text-primary">
              {t("landing.nav.cambodia")}
            </a>
          </nav>

          <LanguageToggle className="text-text-secondary" />

          <Button asChild size="sm" className="tap-target hidden md:inline-flex">
            <Link to="/sign-up">{t("landing.nav.start")}</Link>
          </Button>

          <button
            className="tap-target flex size-9 items-center justify-center rounded-lg text-text-secondary md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? t("landing.nav.closeMenu") : t("landing.nav.openMenu")}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>

        {mobileOpen && (
          <nav
            className="border-t border-border-default bg-surface-primary px-5 py-4 md:hidden"
            aria-label={t("landing.nav.mobileNav")}
          >
            <ul className="space-y-1">
              {[
                { href: "#product", label: t("landing.nav.product") },
                { href: "#workflow", label: t("landing.nav.workflow") },
                { href: "#cambodia", label: t("landing.nav.cambodia") },
              ].map(({ href, label }) => (
                <li key={href}>
                  <a
                    href={href}
                    className="tap-target text-body flex items-center text-text-secondary"
                    onClick={() => setMobileOpen(false)}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
            <Button asChild size="sm" className="tap-target mt-4 w-full">
              <Link to="/sign-up" onClick={() => setMobileOpen(false)}>
                {t("landing.nav.start")}
              </Link>
            </Button>
          </nav>
        )}
      </header>

      {/* ── Hero ── */}
      <section
        className="gradient-brand px-5 pb-16 pt-14 text-text-inverse"
        aria-labelledby="hero-heading"
      >
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 md:grid-cols-2">
          <div>
            <p className="text-label mb-3 opacity-80">{t("landing.hero.badge")}</p>
            <h1 id="hero-heading" className="text-display font-bold leading-tight">
              {t("landing.hero.title")}
            </h1>
            <p className="text-body mt-4 max-w-md opacity-85">{t("landing.hero.lead")}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg" variant="secondary" className="tap-target press">
                <Link to="/sign-up">
                  {t("landing.hero.primary")}
                  <ArrowRight className="ml-1.5 size-4" aria-hidden />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="tap-target border-white/30 bg-transparent text-text-inverse hover:bg-white/10"
              >
                <a href="#workflow">{t("landing.hero.secondary")}</a>
              </Button>
            </div>
          </div>

          {/* Inline inbox preview panel */}
          <div
            className="overflow-hidden rounded-2xl bg-surface-primary shadow-2xl"
            aria-label={t("landing.hero.inboxPreviewLabel")}
          >
            <div className="flex items-center gap-2 border-b border-border-default px-4 py-3">
              <span className="text-label text-text-primary flex-1">{t("landing.inbox.title")}</span>
              <span className="text-caption rounded-full bg-action-primary px-2 py-0.5 text-white">3</span>
            </div>
            <ul className="divide-y divide-border-default text-text-primary">
              {(
                [
                  { channel: "facebook", status: "unread", name: t("landing.hero.demoName1"), msg: t("landing.hero.demoMessage") },
                  { channel: "instagram", status: "needs_reply", name: t("landing.hero.demoName2"), msg: t("landing.hero.demoCustomer") },
                  { channel: "telegram", status: "follow_up", name: t("landing.hero.demoName3"), msg: t("landing.hero.demoOrder") },
                ] as const
              ).map(({ channel, status, name, msg }) => (
                <li key={channel} className="flex items-start gap-3 px-4 py-3">
                  <ChannelBadge channel={channel} />
                  <div className="min-w-0 flex-1">
                    <p className="text-label truncate">{name}</p>
                    <p className="text-caption mt-0.5 truncate text-text-secondary">{msg}</p>
                  </div>
                  <StatusChip status={status} />
                </li>
              ))}
            </ul>
            <div className="border-t border-border-default bg-surface-secondary px-4 py-2.5">
              <p className="text-caption text-text-secondary">{t("landing.hero.demoTransit")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem ── */}
      <Sec id="product" className="bg-surface-secondary" aria-labelledby="problem-heading">
        <Eyebrow>{t("landing.problem.tag")}</Eyebrow>
        <h2 id="problem-heading" className="text-h1 mt-4">{t("landing.problem.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.problem.body")}</p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {[
            t("landing.problem.pain1"),
            t("landing.problem.pain2"),
            t("landing.problem.pain3"),
            t("landing.problem.pain4"),
            t("landing.problem.pain5"),
            t("landing.problem.pain6"),
          ].map((pain) => (
            <div
              key={pain}
              className="flex items-start gap-3 rounded-2xl border border-border-default bg-surface-primary p-4"
            >
              <span className="mt-0.5 size-2 shrink-0 rounded-full bg-companion-luma" aria-hidden />
              <p className="text-body-sm text-text-secondary">{pain}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-action-primary/20 bg-action-primary-soft p-4">
          <ApsiIllustration pose="merging" size={44} alt="" aria-hidden />
          <p className="text-label text-action-primary">{t("landing.problem.result")}</p>
        </div>
      </Sec>

      {/* ── APSA Flow ── */}
      <Sec id="workflow" aria-labelledby="flow-heading">
        <Eyebrow>{t("landing.flow.badge")}</Eyebrow>
        <h2 id="flow-heading" className="text-h1 mt-4">{t("landing.flow.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.flow.body")}</p>

        <div
          className="mt-8 flex flex-wrap items-center gap-1.5"
          role="list"
          aria-label={t("landing.flow.flowLabel")}
        >
          {flowSteps.map(({ icon: Icon, key, label }, i) => (
            <div key={key} className="flex items-center gap-1.5" role="listitem">
              <div className="flex items-center gap-2 rounded-xl border border-border-default bg-surface-secondary px-3 py-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-action-primary-soft text-action-primary">
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="text-body-sm font-medium">{label}</span>
              </div>
              {i < flowSteps.length - 1 && (
                <ArrowRight className="size-3.5 shrink-0 text-text-secondary" aria-hidden />
              )}
            </div>
          ))}
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            { n: "01", title: t("landing.flow.step1"), desc: t("landing.flow.step1desc") },
            { n: "02", title: t("landing.flow.step3"), desc: t("landing.flow.step3desc") },
            { n: "03", title: t("landing.flow.step4"), desc: t("landing.flow.step4desc") },
          ].map(({ n, title, desc }) => (
            <article key={n} className="rounded-2xl border border-border-default bg-surface-secondary p-5">
              <span className="text-financial text-action-primary">{n}</span>
              <h3 className="text-h3 mt-2">{title}</h3>
              <p className="text-body-sm mt-1.5 text-text-secondary">{desc}</p>
            </article>
          ))}
        </div>
      </Sec>

      {/* ── Unified Inbox ── */}
      <Sec className="bg-surface-secondary" aria-labelledby="inbox-heading">
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <Eyebrow>{t("landing.inbox.badge")}</Eyebrow>
            <h2 id="inbox-heading" className="text-h1 mt-4">{t("landing.inbox.title")}</h2>
            <p className="text-body mt-3 text-text-secondary">{t("landing.inbox.body")}</p>
          </div>

          <div
            className="overflow-hidden rounded-2xl border border-border-default bg-surface-primary"
            aria-label={t("landing.inbox.channelOverviewLabel")}
          >
            <div className="border-b border-border-default px-4 py-3">
              <p className="text-label">{t("landing.inbox.title")}</p>
            </div>
            <ul className="divide-y divide-border-default">
              {(
                [
                  { channel: "facebook", status: "unread" },
                  { channel: "instagram", status: "needs_reply" },
                  { channel: "telegram", status: "follow_up" },
                ] as const
              ).map(({ channel, status }) => (
                <li key={channel} className="flex items-center gap-3 px-4 py-3">
                  <ChannelBadge channel={channel} withLabel />
                  <span className="flex-1" />
                  <StatusChip status={status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Sec>

      {/* ── Message → Order ── */}
      <Sec aria-labelledby="msgorder-heading">
        <Eyebrow>{t("landing.msgToOrder.badge")}</Eyebrow>
        <h2 id="msgorder-heading" className="text-h1 mt-4">{t("landing.msgToOrder.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.msgToOrder.body")}</p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            {
              step: "1",
              title: t("landing.msgToOrder.step1"),
              accent: "bg-action-primary-soft text-action-primary",
              icon: MessageSquare,
              detail: (
                <div className="mt-3 rounded-xl bg-surface-secondary p-3">
                  <p className="text-body-sm font-medium">"{t("landing.msgToOrder.step1msg")}"</p>
                  <p className="text-caption mt-1 text-text-secondary">{t("landing.msgToOrder.step1detail")}</p>
                </div>
              ),
            },
            {
              step: "2",
              title: t("landing.msgToOrder.step2"),
              accent: "bg-companion-minto/15 text-companion-minto",
              icon: Package,
              detail: (
                <div className="mt-3 rounded-xl bg-surface-secondary p-3">
                  <p className="text-caption text-text-secondary">{t("landing.msgToOrder.step2hint")}</p>
                </div>
              ),
            },
            {
              step: "3",
              title: t("landing.msgToOrder.step3"),
              accent: "bg-companion-vela/15 text-companion-vela",
              icon: Check,
              detail: (
                <div className="mt-3 rounded-xl bg-surface-secondary p-3">
                  <p className="text-label text-action-primary">{t("landing.msgToOrder.step3code")}</p>
                  <p className="text-caption mt-1 text-text-secondary">{t("landing.msgToOrder.step3detail")}</p>
                </div>
              ),
            },
          ].map(({ step, title, accent, icon: Icon, detail }) => (
            <article
              key={step}
              className="rounded-2xl border border-border-default bg-surface-secondary p-5"
            >
              <div className="flex items-center gap-3">
                <span className={`flex size-8 items-center justify-center rounded-xl ${accent}`}>
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="text-financial text-text-secondary">{step}</span>
              </div>
              <h3 className="text-h3 mt-3">{title}</h3>
              {detail}
            </article>
          ))}
        </div>
      </Sec>

      {/* ── Business Operations ── */}
      <Sec className="bg-surface-secondary" aria-labelledby="ops-heading">
        <Eyebrow>{t("landing.ops.badge")}</Eyebrow>
        <h2 id="ops-heading" className="text-h1 mt-4">{t("landing.ops.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.ops.body")}</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {opsCards.map(({ icon: Icon, title, body, accent }) => (
            <article
              key={title}
              className="rounded-2xl border border-border-default bg-surface-primary p-5 transition-shadow hover:elevation-1"
            >
              <span className={`flex size-10 items-center justify-center rounded-xl ${accent}`}>
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="text-h3 mt-4">{title}</h3>
              <p className="text-body-sm mt-1.5 text-text-secondary">{body}</p>
            </article>
          ))}
        </div>
      </Sec>

      {/* ── Customer 360 ── */}
      <Sec aria-labelledby="c360-heading">
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <Eyebrow>{t("landing.c360.badge")}</Eyebrow>
            <h2 id="c360-heading" className="text-h1 mt-4">{t("landing.c360.title")}</h2>
            <p className="text-body mt-3 text-text-secondary">{t("landing.c360.body")}</p>
          </div>

          <div
            className="overflow-hidden rounded-2xl border border-border-default bg-surface-primary"
            aria-label={t("landing.c360.profilePreviewLabel")}
          >
            <div className="flex items-center gap-3 border-b border-border-default px-4 py-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-action-primary-soft text-action-primary">
                <User className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-label">Sophea Chan</p>
                <p className="text-caption text-text-secondary">
                  <ChannelBadge channel="facebook" />
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border-default">
              {[
                { icon: Package, label: t("landing.c360.detail1") },
                { icon: Truck, label: t("landing.c360.detail2") },
                { icon: Banknote, label: t("landing.c360.detail3") },
                { icon: MessageSquare, label: t("landing.c360.detail4") },
              ].map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon className="size-4 shrink-0 text-text-secondary" aria-hidden />
                  <span className="text-body-sm text-text-secondary">{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Sec>

      {/* ── Built for Cambodia ── */}
      <Sec id="cambodia" className="bg-surface-secondary" aria-labelledby="cambodia-heading">
        <Eyebrow>{t("landing.cambodia.badge")}</Eyebrow>
        <h2 id="cambodia-heading" className="text-h1 mt-4">{t("landing.cambodia.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.cambodia.body")}</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {cambodiaItems.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              className="rounded-2xl border border-border-default bg-surface-primary p-5"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-action-primary-soft text-action-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="text-h3 mt-4">{title}</h3>
              <p className="text-body-sm mt-1.5 text-text-secondary">{body}</p>
            </article>
          ))}
        </div>
      </Sec>

      {/* ── Team / Roles ── */}
      <Sec aria-labelledby="team-heading">
        <Eyebrow>{t("landing.lteam.badge")}</Eyebrow>
        <h2 id="team-heading" className="text-h1 mt-4">{t("landing.lteam.title")}</h2>
        <p className="text-body mt-3 max-w-2xl text-text-secondary">{t("landing.lteam.body")}</p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {teamRoles.map(({ title, desc, accent }) => (
            <article
              key={title}
              className="rounded-2xl border border-border-default bg-surface-secondary p-4"
            >
              <span className={`text-label inline-block rounded-lg px-2.5 py-1 ${accent}`}>
                {title}
              </span>
              <p className="text-body-sm mt-3 text-text-secondary">{desc}</p>
            </article>
          ))}
        </div>
      </Sec>

      {/* ── Apsi Moment (dark) ── */}
      <section
        className="bg-surface-inverse px-5 py-16 text-text-inverse"
        aria-labelledby="apsi-heading"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 text-center">
          <ApsiIllustration pose="waving" size={80} alt={t("brand.name")} />
          <h2 id="apsi-heading" className="text-h1 text-text-inverse">
            {t("landing.apsi.title")}
          </h2>
          <p className="text-body max-w-lg opacity-80">{t("landing.apsi.body")}</p>
          <Button asChild size="lg" className="tap-target press mt-2">
            <Link to="/sign-up">
              {t("landing.apsi.action")}
              <ArrowRight className="ml-1.5 size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section
        className="gradient-brand px-5 py-16 text-text-inverse"
        aria-labelledby="cta-heading"
      >
        <div className="mx-auto w-full max-w-3xl text-center">
          <h2 id="cta-heading" className="text-h1">{t("landing.cta.title")}</h2>
          <p className="text-body mt-3 opacity-90">{t("landing.cta.body")}</p>
          <Button asChild size="lg" variant="secondary" className="tap-target press mt-6">
            <Link to="/sign-up">
              {t("landing.cta.action")}
              <ArrowRight className="ml-1.5 size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border-default px-5 py-10">
        <div className="mx-auto grid w-full max-w-5xl gap-8 sm:grid-cols-4">
          <div>
            <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
            <p className="text-body-sm mt-1.5 text-text-secondary">{t("brand.tagline")}</p>
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
        <p className="text-caption mx-auto mt-8 w-full max-w-5xl text-text-secondary">
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
      <ul className="mt-2.5 space-y-2">
        {items.map((item) => (
          <li key={item}>
            <span className="text-body-sm text-text-secondary">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
