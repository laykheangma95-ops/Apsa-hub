/**
 * The `@/api/capabilities` server function, stubbed for the POS
 * payment-stacking browser fixture ONLY.
 *
 * `use-capabilities.tsx` imports it at module scope, so bundling the real
 * <PosCheckoutSheet> for a browser drags in TanStack Start's server entry,
 * which cannot resolve outside the Nitro runtime. The fixture renders through
 * CapabilityFixtureProvider, so this function is never actually called — it
 * exists to keep the import graph bundleable.
 *
 * Aliased in src/tests/pos-payment-stacking.browser.ts; unreachable from any
 * production build.
 */
export async function getActiveMemberCapabilitiesFn(): Promise<never> {
  throw new Error(
    "getActiveMemberCapabilitiesFn is not available in the browser fixture — " +
      "the fixture supplies capabilities through CapabilityFixtureProvider.",
  );
}
