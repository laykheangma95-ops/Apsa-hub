/**
 * Browser fixture for the BottomSheet focus-trap regression.
 *
 * Mounted in a real Chromium by src/tests/bottom-sheet-focus-trap.browser.ts.
 * It renders the actual <BottomSheet>, so the keydown and focusin handlers
 * under test are the shipped ones — not a copy — and every candidate below is
 * judged by the real browser's own layout, computed style and focusability
 * rules rather than by a stub that agrees with us by construction.
 *
 * The sheet's content is the reported repro, in DOM order:
 *
 *   #name        controlled input — proves keystrokes do not churn focus
 *   #before      ordinary control; the one focus got stuck on
 *   #invisible   visibility: hidden — laid out, has client rects, unfocusable
 *   #legend-btn  in the first <legend> of a disabled fieldset — still focusable
 *   #deep-legend-btn   first legend of a disabled fieldset that itself sits
 *                inside the outer fieldset's first legend — reached by neither,
 *                so still focusable
 *   #deep-fs-input     inside that same nested fieldset but outside its legend
 *                — disabled by it, even though the outer one cannot reach it
 *   #nested-legend-btn first legend of a disabled fieldset nested *outside* the
 *                outer legend — the outer fieldset still reaches it, so HTML
 *                and Chromium both call it disabled. The old nearest-fieldset
 *                rule cleared it and stranded focus on the control before it.
 *   #nested-fs-input   likewise, by both fieldsets
 *   #fs-input    inside <fieldset disabled> — unfocusable, and carries no
 *                `disabled` attribute of its own
 *   #fs-btn      likewise
 *   #after       the control a merchant must be able to Tab to
 *   #fixed       position: fixed — focusable, and the false negative an
 *                `offsetParent` heuristic would have wrongly dropped
 *   #save        ordinary footer control
 *
 * `?empty=1` renders the same sheet with no focusable content at all, for the
 * case where Tab has nowhere to go and must still be swallowed.
 *
 * `?details=1` renders a separate, minimal sheet for the closed-<details>
 * regression (kept apart from the fixture above so its own exact tab order
 * does not have to be threaded through every existing ordered assertion):
 *
 *   #d-before                  ordinary control before the details
 *   #d-details (closed)
 *     #d-summary                the disclosure widget — always focusable
 *     #d-collapsed               inside the collapsed body — NOT focusable
 *                                 until the details is opened
 *   #d-after                   ordinary control after the details
 *   #d-nested-outer (closed)
 *     #d-nested-outer-summary   the OUTER details' own eligible summary —
 *                                 focusable regardless of its own children
 *     #d-nested-inner (open)     nested inside the outer's collapsed body;
 *       #d-nested-inner-summary  an open details changes nothing: the outer
 *       #d-nested-inner-input    closed details still hides this whole subtree
 *   #d-end                     ordinary control after everything
 *
 * `?details-nested=1` covers the P2-1/P2-2 re-review: ancestry that requires
 * walking EVERY closed <details> ancestor (not just the nearest), the
 * controlling-vs-second-<summary> distinction, and recovery past a candidate
 * that structurally looks focusable but loses focus at runtime.
 *
 *   #n-before
 *   #n-both-closed-outer (closed)
 *     #n-both-closed-outer-summary   reachable — outer's own controlling summary
 *     #n-both-closed-inner (closed)
 *       #n-both-closed-inner-summary NOT reachable — it IS inner's own
 *                                     controlling summary, but inner itself
 *                                     sits inside outer's collapsed body
 *                                     (the exact P2-1 regression)
 *       #n-both-closed-inner-input   NOT reachable
 *   #n-mid1
 *   #n-ooic-outer (OPEN)
 *     #n-ooic-outer-summary
 *     #n-ooic-inner (closed)
 *       #n-ooic-inner-summary        reachable — outer is open, so inner's own
 *                                     closed-details rule is all that applies
 *       #n-ooic-inner-input          NOT reachable — inner is still closed
 *   #n-mid2
 *   #n-both-open-outer (open)
 *     #n-both-open-outer-summary
 *     #n-both-open-inner (open)
 *       #n-both-open-inner-summary   all reachable — nothing closed anywhere
 *       #n-both-open-inner-input
 *   #n-mid3
 *   #n-second-summary (open)
 *     #n-second-summary-first        reachable — the controlling summary
 *     #n-second-summary-second       NOT reachable — a second <summary> has
 *                                     no native tab stop, controlling or not
 *     #n-second-summary-input        reachable — ordinary open-details content
 *   #n-mid4
 *   #n-persistent-fail                looks like an ordinary focusable button
 *                                     to every structural/geometric check, but
 *                                     blurs itself the instant it receives
 *                                     focus (test-only — see its onFocus).
 *                                     Proves recovery past a candidate that
 *                                     is not caught by candidate filtering at
 *                                     all, only by verifying focus actually
 *                                     landed.
 *   #n-after
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BottomSheet } from "@/design-system/BottomSheet";
import { collectTrapFocusables } from "@/design-system/focus-trap";
import "@/lib/i18n";

declare global {
  interface Window {
    /**
     * The trap's own verdict, as ids. The browser test compares it against the
     * set Chromium will actually focus, so the rule is checked against the
     * platform rather than against our own assumptions about it.
     */
    apsaTrapStops?: () => string[];
  }
}

window.apsaTrapStops = () => {
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  return panel ? collectTrapFocusables(panel).map((element) => element.id) : [];
};

export type FixtureVariant = "default" | "empty" | "details" | "details-nested";

// Exported so this fixture is a module with a component export rather than a
// component-only side-effect script; the mount below is still what the
// browser test loads.
export function Fixture({ variant }: { variant: FixtureVariant }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  return (
    <div>
      <button id="background" type="button">
        Behind the sheet
      </button>
      <button id="trigger" type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <BottomSheet
        open={open}
        // Recreated on every render on purpose: consumers pass an inline
        // callback, and that identity churn is what used to steal focus back
        // to the panel between keystrokes.
        onOpenChange={(next) => setOpen(next)}
        title="Focus trap fixture"
        {...(variant === "default"
          ? {
              footer: (
                <button id="save" type="button">
                  Save
                </button>
              ),
            }
          : {})}
      >
        {variant === "empty" ? (
          <p id="empty-copy">Nothing focusable in here.</p>
        ) : variant === "details" ? (
          <>
            <button id="d-before" type="button">
              Before
            </button>
            <details id="d-details">
              <summary id="d-summary">Toggle</summary>
              <div>
                <input id="d-collapsed" type="text" />
              </div>
            </details>
            <button id="d-after" type="button">
              After
            </button>
            {/* Nested case: the outer details is closed, so its collapsed body
                hides the entire inner <details> — summary included — even
                though the inner one is itself open. Only the outer details'
                OWN eligible summary is exempt. */}
            <details id="d-nested-outer">
              <summary id="d-nested-outer-summary">Outer</summary>
              <details open id="d-nested-inner">
                <summary id="d-nested-inner-summary">Inner</summary>
                <input id="d-nested-inner-input" type="text" />
              </details>
            </details>
            <button id="d-end" type="button">
              End
            </button>
          </>
        ) : variant === "details-nested" ? (
          <>
            <button id="n-before" type="button">
              Before
            </button>

            {/* A: both closed. Only n-both-closed-outer-summary is reachable —
                the P2-1 regression is n-both-closed-inner-summary, which IS
                the inner's own controlling summary but still sits inside the
                outer's collapsed body. */}
            <details id="n-both-closed-outer">
              <summary id="n-both-closed-outer-summary">Outer closed</summary>
              <details id="n-both-closed-inner">
                <summary id="n-both-closed-inner-summary">Inner closed</summary>
                <input id="n-both-closed-inner-input" type="text" />
              </details>
            </details>
            <button id="n-mid1" type="button">
              Mid 1
            </button>

            {/* B: outer open, inner closed. */}
            <details id="n-ooic-outer" open>
              <summary id="n-ooic-outer-summary">Outer open</summary>
              <details id="n-ooic-inner">
                <summary id="n-ooic-inner-summary">Inner closed</summary>
                <input id="n-ooic-inner-input" type="text" />
              </details>
            </details>
            <button id="n-mid2" type="button">
              Mid 2
            </button>

            {/* C: both open — normal focusability throughout. */}
            <details id="n-both-open-outer" open>
              <summary id="n-both-open-outer-summary">Outer open</summary>
              <details open id="n-both-open-inner">
                <summary id="n-both-open-inner-summary">Inner open</summary>
                <input id="n-both-open-inner-input" type="text" />
              </details>
            </details>
            <button id="n-mid3" type="button">
              Mid 3
            </button>

            {/* D: second <summary>. Only the first is the disclosure widget;
                the second gets no native tab stop, controlling or not. */}
            <details id="n-second-summary" open>
              <summary id="n-second-summary-first">First</summary>
              <summary id="n-second-summary-second">Second</summary>
              <input id="n-second-summary-input" type="text" />
            </details>
            <button id="n-mid4" type="button">
              Mid 4
            </button>

            {/* E: persistent focus failure, test-only. Every structural and
                geometric check the trap runs says this is an ordinary
                focusable button — it is one. What it does at runtime is blur
                itself the instant it is focused, exactly reproducing "looks
                eligible, .focus() never actually lands" without any
                production hack. Proves resolveTrapFocus's recovery, which
                candidate filtering alone cannot cover. */}
            <button
              id="n-persistent-fail"
              type="button"
              onFocus={(event) => event.currentTarget.blur()}
            >
              Refuses focus
            </button>

            <button id="n-after" type="button">
              After
            </button>
          </>
        ) : (
          <>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
            <button id="before" type="button">
              Before
            </button>
            <button id="invisible" type="button" style={{ visibility: "hidden" }}>
              Invisible
            </button>
            <fieldset disabled>
              <legend>
                <button id="legend-btn" type="button">
                  Legend
                </button>
                {/* Nested inside the outer fieldset's OWN first legend, so the
                    outer fieldset does not reach it and its own first legend
                    is enabled — while its other controls are not. */}
                <fieldset disabled>
                  <legend>
                    <button id="deep-legend-btn" type="button">
                      Deep legend
                    </button>
                  </legend>
                  <input id="deep-fs-input" type="text" />
                </fieldset>
              </legend>
              {/* The P2 defect. #nested-legend-btn is the first legend of this
                  inner disabled fieldset, so the old "is there a first legend
                  above me?" rule cleared it — but it is also an ordinary
                  descendant of the OUTER disabled fieldset, which still
                  reaches it. Chromium reports it :disabled and refuses focus. */}
              <fieldset disabled>
                <legend>
                  <button id="nested-legend-btn" type="button">
                    Nested legend
                  </button>
                </legend>
                <input id="nested-fs-input" type="text" />
              </fieldset>
              <input id="fs-input" type="text" />
              <button id="fs-btn" type="button">
                Fieldset
              </button>
            </fieldset>
            <button id="after" type="button">
              After
            </button>
            <button id="fixed" type="button" style={{ position: "fixed", top: 0, left: 0 }}>
              Fixed
            </button>
          </>
        )}
      </BottomSheet>
    </div>
  );
}

function variantFromQuery(): FixtureVariant {
  const params = new URLSearchParams(window.location.search);
  if (params.get("empty") === "1") return "empty";
  if (params.get("details-nested") === "1") return "details-nested";
  if (params.get("details") === "1") return "details";
  return "default";
}

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <Fixture variant={variantFromQuery()} />
    </StrictMode>,
  );
}
