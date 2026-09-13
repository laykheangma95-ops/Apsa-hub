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

// Exported so this fixture is a module with a component export rather than a
// component-only side-effect script; the mount below is still what the
// browser test loads.
export function Fixture({ empty }: { empty: boolean }) {
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
        {...(empty
          ? {}
          : {
              footer: (
                <button id="save" type="button">
                  Save
                </button>
              ),
            })}
      >
        {empty ? (
          <p id="empty-copy">Nothing focusable in here.</p>
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
              </legend>
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

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <Fixture empty={new URLSearchParams(window.location.search).get("empty") === "1"} />
    </StrictMode>,
  );
}
