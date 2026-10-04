/**
 * APSA server-function method policy — the rules server-fn-method-guard.test.ts
 * enforces over the real repository, as a pure function so the guard's own
 * fixture tests (server-fn-inventory-fixtures.test.ts) prove each rule fires.
 */
import type { ServerFnDefinition, ServerFnInventory } from "./server-fn-inventory";

export interface ReadOnlyEntry {
  reason: string;
  /**
   * Write-verb calls the handler is allowed to make because they maintain the
   * caller's OWN session cookies (token refresh / clearing an expired or
   * revoked session) — never domain data. Reviewed individually.
   */
  sessionMaintenance?: string[];
}

export type ReadOnlyRegistry = Record<string, ReadOnlyEntry>;

export const READ_NAME = /^(get|list|find|lookup|search|resolve|preview|validate|check)[A-Z]/;

/** A call whose name says it writes. Read handlers must not make one. */
export const WRITE_CALL =
  /^(create|update|upsert|insert|delete|remove|record|mark|transition|confirm|cancel|refund|reverse|verify|correct|attach|archive|generate|receive|inspect|complete|request|invite|resend|change|deactivate|reactivate|accept|assign|recover|retry|sign|clear|write|set|add|pack|ingest)(?:[A-Z]|$)/;

/** Client factories, not writes. */
const NON_WRITE_FACTORIES = new Set(["createAnonAuthClient", "createServerClient", "createClient"]);

export interface PolicyViolations {
  /** createServerFn reached other than by the canonical named import + direct call. */
  nonCanonical: string[];
  /** createServerFn calls that are not an exported const definition. */
  unbound: string[];
  /** Two server functions with the same exported name. */
  duplicateNames: string[];
  /** Method computed at runtime — cannot be verified. */
  nonLiteralMethod: string[];
  /** Not a registered read, yet not explicitly POST. */
  notPost: string[];
  /** Registered read that no longer exists as a GET server function. */
  staleReads: string[];
  /** Registered read without a read-verb name. */
  misnamedReads: string[];
  /** Registered read whose handler makes a write-verb call. */
  writesInReads: string[];
}

export const describeFn = (d: ServerFnDefinition) =>
  `${d.name} (${d.file}:${d.line}, method=${d.method})`;

export function checkServerFnPolicy(
  inventory: ServerFnInventory,
  registry: ReadOnlyRegistry,
): PolicyViolations {
  const byName = new Map<string, ServerFnDefinition>();
  const duplicateNames: string[] = [];
  for (const d of inventory.definitions) {
    if (byName.has(d.name)) duplicateNames.push(d.name);
    byName.set(d.name, d);
  }

  const writesInReads: string[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    const def = byName.get(name);
    if (!def) continue;
    const allowed = new Set(entry.sessionMaintenance ?? []);
    for (const callee of def.handlerCallees) {
      if (NON_WRITE_FACTORIES.has(callee) || allowed.has(callee)) continue;
      if (WRITE_CALL.test(callee) && !READ_NAME.test(callee))
        writesInReads.push(`${name} → ${callee}`);
    }
  }

  return {
    nonCanonical: inventory.nonCanonicalUses.map((u) => `${u.kind} (${u.file}:${u.line})`),
    unbound: inventory.unboundCalls.map((u) => `${u.file}:${u.line}`),
    duplicateNames,
    nonLiteralMethod: inventory.definitions
      .filter((d) => d.method === "non-literal")
      .map(describeFn),
    notPost: inventory.definitions
      .filter((d) => !(d.name in registry) && d.method !== "POST")
      .map(describeFn),
    staleReads: Object.keys(registry).filter((name) => byName.get(name)?.effectiveMethod !== "GET"),
    misnamedReads: Object.keys(registry).filter((name) => !READ_NAME.test(name)),
    writesInReads,
  };
}
