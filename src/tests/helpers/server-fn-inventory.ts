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

export interface ServerFnInventory {
  definitions: ServerFnDefinition[];
  /** createServerFn calls that are not `export const X = createServerFn(...)...`. */
  unboundCalls: { file: string; line: number }[];
}

const SOURCE_ROOT = "src";
const EXCLUDED_DIRS = new Set(["tests", "node_modules"]);

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

function isCreateServerFnCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createServerFn"
  );
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
    if (
      ts.isStringLiteral(prop.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(prop.initializer)
    ) {
      const value = prop.initializer.text;
      return value === "GET" || value === "POST" ? value : "non-literal";
    }
    return "non-literal";
  }
  return "default";
}

/** The innermost call at the root of a `createServerFn(...).a(...).b(...)` chain. */
function chainRoot(expr: ts.Expression): ts.CallExpression | undefined {
  let current: ts.Expression = expr;
  for (;;) {
    if (isCreateServerFnCall(current)) return current;
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

export function inventoryServerFns(cwd: string = process.cwd()): ServerFnInventory {
  const definitions: ServerFnDefinition[] = [];
  const unboundCalls: { file: string; line: number }[] = [];

  for (const absolute of listSourceFiles(path.join(cwd, SOURCE_ROOT))) {
    const text = fs.readFileSync(absolute, "utf-8");
    if (!text.includes("createServerFn")) continue;
    const file = path.relative(cwd, absolute).split(path.sep).join("/");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const bound = new Set<ts.CallExpression>();

    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of statement.declarationList.declarations) {
        if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
        const root = chainRoot(decl.initializer);
        if (!root || !exported) continue;
        bound.add(root);
        const method = declaredMethod(root);
        definitions.push({
          name: decl.name.text,
          file,
          line: source.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
          method,
          effectiveMethod:
            method === "POST" ? "POST" : method === "non-literal" ? "unknown" : "GET",
          handlerCallees: collectCallees(handlerArgument(decl.initializer)),
        });
      }
    }

    const visit = (n: ts.Node) => {
      if (isCreateServerFnCall(n) && !bound.has(n)) {
        unboundCalls.push({
          file,
          line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  definitions.sort((a, b) => a.name.localeCompare(b.name));
  return { definitions, unboundCalls };
}
