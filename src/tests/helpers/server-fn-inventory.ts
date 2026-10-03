/**
 * Server-function inventory — a TypeScript-AST walk over every source file
 * (tests excluded) that finds every createServerFn() call and reports the HTTP
 * method it actually declares.
 *
 * Why the AST and not a regex: the method is read from the real argument of the
 * real call (`createServerFn({ method: "POST" })`), and the handler body is
 * available for the read-only check in server-fn-method-guard.test.ts. A
 * createServerFn call that is not the root of an exported `const` is reported
 * too, so nothing can hide from the inventory behind a different shape.
 *
 * Calls are recognised by BINDING, not by spelling: `createServerFn` counts
 * only when it is imported from a TanStack Start module, whether through the
 * canonical named import, an alias (`import { createServerFn as csf }`) or a
 * namespace (`import * as TS` → `TS.createServerFn(...)`). A local function
 * that merely happens to be called createServerFn is not the framework
 * primitive and is ignored.
 *
 * APSA allows only the canonical form. Every other way of reaching the
 * primitive — alias, namespace/default import, re-export, dynamic import, or a
 * non-call reference such as `const f = createServerFn` — is reported in
 * `nonCanonicalUses`, because each is a route by which a future server
 * function could escape this inventory.
 *
 * TanStack Start 1.168 (start-client-core/createServerFn.js) defaults an
 * omitted method to "GET", and its client fetcher serializes a GET call's
 * entire payload into the `?payload=` query string. "default" below therefore
 * means GET.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export type DeclaredMethod = "default" | "GET" | "POST" | "non-literal";

export interface ServerFnDefinition {
  name: string;
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  method: DeclaredMethod;
  /** Effective HTTP method the framework will use. */
  effectiveMethod: "GET" | "POST" | "unknown";
  /** Identifiers called anywhere inside the .handler(...) argument. */
  handlerCallees: string[];
}

export interface SourceLocation {
  file: string;
  line: number;
}

export interface NonCanonicalUse extends SourceLocation {
  kind:
    | "aliased-import"
    | "namespace-import"
    | "default-import"
    | "re-export"
    | "dynamic-import"
    | "escaped-reference";
}

export interface ServerFnInventory {
  definitions: ServerFnDefinition[];
  /** createServerFn calls that are not `export const X = createServerFn(...)...`. */
  unboundCalls: SourceLocation[];
  /** Ways of reaching createServerFn other than the canonical named import + direct call. */
  nonCanonicalUses: NonCanonicalUse[];
}

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  file: string;
  text: string;
}

const SOURCE_ROOT = "src";
const EXCLUDED_DIRS = new Set(["tests", "node_modules"]);
const PRIMITIVE = "createServerFn";

/**
 * TanStack Start packages (react-start, start-client-core, their sub-paths, and
 * any other framework flavour). Deliberately broad: a false match only makes
 * the guard stricter.
 */
export function isFrameworkModule(specifier: string): boolean {
  return /^@tanstack\/[^/]*start/.test(specifier);
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...listSourceFiles(path.join(dir, entry.name)));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** How createServerFn is reachable in one file. */
interface Bindings {
  /** Local identifiers bound to createServerFn (canonical or aliased). */
  direct: Set<string>;
  /** Local identifiers bound to a whole framework module (namespace / default). */
  namespaces: Set<string>;
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function declaredMethod(call: ts.CallExpression): DeclaredMethod {
  const [options] = call.arguments;
  if (!options) return "default";
  if (!ts.isObjectLiteralExpression(options)) return "non-literal";
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      if (ts.isSpreadAssignment(prop)) return "non-literal";
      continue;
    }
    const key = prop.name;
    const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (keyText !== "method") continue;
    const value = stringLiteralText(prop.initializer);
    if (value !== undefined) return value === "GET" || value === "POST" ? value : "non-literal";
    return "non-literal";
  }
  return "default";
}

/** True when `expr` evaluates to the framework's createServerFn in this file. */
function isPrimitiveReference(expr: ts.Expression, bindings: Bindings): boolean {
  if (ts.isIdentifier(expr)) return bindings.direct.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      bindings.namespaces.has(expr.expression.text) &&
      expr.name.text === PRIMITIVE
    );
  }
  if (ts.isElementAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      bindings.namespaces.has(expr.expression.text) &&
      stringLiteralText(expr.argumentExpression) === PRIMITIVE
    );
  }
  return false;
}

function isPrimitiveCall(node: ts.Node, bindings: Bindings): node is ts.CallExpression {
  return ts.isCallExpression(node) && isPrimitiveReference(node.expression, bindings);
}

/** The innermost call at the root of a `createServerFn(...).a(...).b(...)` chain. */
function chainRoot(expr: ts.Expression, bindings: Bindings): ts.CallExpression | undefined {
  let current: ts.Expression = expr;
  for (;;) {
    if (isPrimitiveCall(current, bindings)) return current;
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      current = current.expression.expression;
      continue;
    }
    return undefined;
  }
}

function handlerArgument(expr: ts.Expression): ts.Node | undefined {
  let current: ts.Expression = expr;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    if (current.expression.name.text === "handler") return current.arguments[0];
    current = current.expression.expression;
  }
  return undefined;
}

function collectCallees(node: ts.Node | undefined): string[] {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(n, visit);
  };
  if (node) visit(node);
  return [...names].sort();
}

/** Inventories one file. Exported for the guard's own fixture tests. */
export function inventorySource({ file, text }: SourceFile): ServerFnInventory {
  const definitions: ServerFnDefinition[] = [];
  const unboundCalls: SourceLocation[] = [];
  const nonCanonicalUses: NonCanonicalUse[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const flag = (kind: NonCanonicalUse["kind"], node: ts.Node) =>
    nonCanonicalUses.push({ kind, file, line: lineOf(node) });

  // 1. Bindings from static imports; re-exports are flagged.
  const bindings: Bindings = { direct: new Set(), namespaces: new Set() };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = stringLiteralText(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (!specifier || !isFrameworkModule(specifier) || !clause) continue;
      if (clause.name) {
        bindings.namespaces.add(clause.name.text);
        flag("default-import", clause.name);
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.namespaces.add(named.name.text);
        flag("namespace-import", named);
      } else if (named) {
        for (const element of named.elements) {
          if ((element.propertyName ?? element.name).text !== PRIMITIVE) continue;
          bindings.direct.add(element.name.text);
          if (element.propertyName) flag("aliased-import", element);
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = stringLiteralText(statement.moduleSpecifier);
      if (!specifier || !isFrameworkModule(specifier)) continue;
      const clause = statement.exportClause;
      const reExportsPrimitive =
        !clause || // export * from "@tanstack/react-start"
        ts.isNamespaceExport(clause) || // export * as TS from ...
        clause.elements.some((e) => (e.propertyName ?? e.name).text === PRIMITIVE);
      if (reExportsPrimitive) flag("re-export", statement);
    }
  }

  // 2. Server-function definitions: `export const X = <primitive>(...)...`.
  const bound = new Set<ts.CallExpression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const root = chainRoot(decl.initializer, bindings);
      if (!root || !exported) continue;
      bound.add(root);
      const method = declaredMethod(root);
      definitions.push({
        name: decl.name.text,
        file,
        line: lineOf(decl),
        method,
        effectiveMethod: method === "POST" ? "POST" : method === "non-literal" ? "unknown" : "GET",
        handlerCallees: collectCallees(handlerArgument(decl.initializer)),
      });
    }
  }

  // 3. Every other primitive call, every escaped reference, every dynamic import.
  const visit = (n: ts.Node) => {
    if (isPrimitiveCall(n, bindings) && !bound.has(n)) {
      unboundCalls.push({ file, line: lineOf(n) });
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isFrameworkModule(stringLiteralText(n.arguments[0]) ?? "")
    ) {
      // `await import("@tanstack/react-start")` hands back the module object,
      // which this static walk cannot follow. Server-only sub-paths that do
      // not export the primitive (e.g. "/server") are allowed.
      const specifier = stringLiteralText(n.arguments[0])!;
      if (!/\/(server|server-entry)$/.test(specifier)) flag("dynamic-import", n);
    }
    if (
      ts.isIdentifier(n) &&
      bindings.direct.has(n.text) &&
      !ts.isImportSpecifier(n.parent) &&
      // `export { createServerFn } from "<framework>"` is already a "re-export"
      !(ts.isExportSpecifier(n.parent) && n.parent.parent.parent.moduleSpecifier) &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n) &&
      // a property NAME (`obj.createServerFn`, `{ createServerFn: x }`) is not the binding
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
    ) {
      // `const f = createServerFn`, passing it as an argument, wrapping it…
      flag("escaped-reference", n);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);

  return { definitions, unboundCalls, nonCanonicalUses };
}

export function inventorySources(sources: SourceFile[]): ServerFnInventory {
  const merged: ServerFnInventory = { definitions: [], unboundCalls: [], nonCanonicalUses: [] };
  for (const src of sources) {
    const one = inventorySource(src);
    merged.definitions.push(...one.definitions);
    merged.unboundCalls.push(...one.unboundCalls);
    merged.nonCanonicalUses.push(...one.nonCanonicalUses);
  }
  merged.definitions.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

export function inventoryServerFns(cwd: string = process.cwd()): ServerFnInventory {
  return inventorySources(
    listSourceFiles(path.join(cwd, SOURCE_ROOT)).map((absolute) => ({
      file: path.relative(cwd, absolute).split(path.sep).join("/"),
      text: fs.readFileSync(absolute, "utf-8"),
    })),
  );
}
