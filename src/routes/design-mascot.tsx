import { createFileRoute } from "@tanstack/react-router";
import {
  APSI_EMOTION_KEYS,
  COMPANION_MEANING,
  COMPANION_TOKEN,
  COMPANION_URL,
  Apsi,
  apsiEmotions,
  MascotMoment,
  type CompanionName,
} from "@/design-system/mascot";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/design-mascot")({
  head: () => ({
    meta: [
      { title: "Apsi mascot system — APSA" },
      {
        name: "description",
        content:
          "Every APSA mascot emotion, companion accent, placement and future-ready asset in one reference.",
      },
      { property: "og:title", content: "Apsi mascot system — APSA" },
      {
        property: "og:description",
        content:
          "The official Apsi visual language: 16 named emotions, companions and asset names.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MascotReference,
});

const COMPANIONS: CompanionName[] = ["nilo", "minto", "vela", "suri", "luma"];

function MascotReference() {
  return (
    <div className="min-h-screen bg-surface-primary px-5 py-10 text-text-primary">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-h1">Apsi mascot system</h1>
        <p className="text-body mt-2 max-w-xl text-text-secondary">
          Screens name an emotion, never a pose or a file. Current stills preserve the approved Apsi
          artwork; future animation swaps happen in one registry.
        </p>

        <section className="mt-10">
          <h2 className="text-h2">Emotions</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {APSI_EMOTION_KEYS.map((key) => {
              const spec = apsiEmotions[key];
              return (
                <li
                  key={key}
                  className="rounded-2xl border border-border-default bg-surface-secondary p-4"
                >
                  <div className="flex items-start gap-3">
                    <Apsi emotion={key} size="sm" withCompanion />
                    <div className="min-w-0">
                      <p className="text-label text-text-primary">{spec.label}</p>
                      <p className="text-caption text-text-muted">{spec.asset}</p>
                    </div>
                  </div>
                  <p className="text-body-sm mt-3 text-text-secondary">{spec.intent}</p>
                  <p className="text-caption mt-2 text-text-secondary">{spec.placement}</p>
                  <p className="text-caption mt-2 text-text-muted">
                    {spec.surface} · {spec.loop ? "loops" : "plays once"} · {spec.animation} ·{" "}
                    {spec.source.kind}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-h2">Companions</h2>
          <div className="mt-4 flex flex-wrap gap-6">
            {COMPANIONS.map((name) => (
              <div key={name} className="w-32 text-center">
                <img src={COMPANION_URL[name]} alt="" className="mx-auto h-20 object-contain" />
                <p className="text-label mt-1" style={{ color: COMPANION_TOKEN[name] }}>
                  {name}
                </p>
                <p className="text-caption text-text-muted">{COMPANION_MEANING[name]}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-h2">Moment block</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <MascotMoment
              variant="card"
              state="approved"
              title="Payment received"
              body="$19.80 confirmed for order APSA-0143."
              action={<Button className="tap-target">View order</Button>}
            />
            <MascotMoment
              variant="card"
              state="excited"
              title="100 orders this month"
              body="Your best month yet — keep the replies fast."
            />
          </div>
        </section>

        <section className="mt-12 mb-10">
          <h2 className="text-h2">Where Apsi may not appear</h2>
          <p className="text-body mt-2 max-w-xl text-text-secondary">
            Inbox lists, conversation threads, POS, order tables and product tables stay
            mascot-free. Those surfaces use the plain operational states instead.
          </p>
        </section>
      </div>
    </div>
  );
}
