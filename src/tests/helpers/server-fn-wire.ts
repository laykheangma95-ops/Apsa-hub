/**
 * What a server function's thrown error becomes by the time the browser's
 * caller sees it — through the installed framework, not a stand-in:
 *
 *   1. src/server/observability/server-fn-boundary.ts (runServerFnBoundary):
 *      APSA public domain errors pass unchanged; anything else becomes the
 *      sanitized internal error with a support reference;
 *   2. start-server-core's handleServerAction: toCrossJSONAsync with
 *      defaultSerovalDeserializerPlugins (src/start.ts registers no
 *      serialization adapters, so these are the plugins it uses);
 *   3. start-client-core's serverFnFetcher: fromCrossJSON with
 *      getDefaultSerovalPlugins(), then `if (result instanceof Error) throw`.
 *
 * Router-core's ShallowErrorPlugin is in both plugin lists: only `message`
 * survives. `statusCode`, `code` and every other own property are dropped.
 */
import {
  defaultSerovalDeserializerPlugins,
  getDefaultSerovalPlugins,
} from "@tanstack/start-client-core";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { fromCrossJSON, toCrossJSONAsync } from "seroval";
import { runServerFnBoundary } from "@/server/observability/server-fn-boundary";

/** The error the browser's caller receives for a server function that threw `error`. */
export async function overServerFnWire(
  error: unknown,
  filename = "src/api/orders.ts",
): Promise<unknown> {
  let thrown: unknown;
  try {
    await runServerFnBoundary({ name: "wire", filename }, async () => {
      throw error;
    });
  } catch (boundaryError) {
    thrown = boundaryError;
  }
  const body = JSON.stringify(
    await toCrossJSONAsync(thrown, { refs: new Map(), plugins: defaultSerovalDeserializerPlugins }),
  );
  // The browser reads its start options from the page; src/start.ts sets none
  // that affect serialization.
  return runWithStartContext({ startOptions: {} } as never, () =>
    fromCrossJSON(JSON.parse(body), { refs: new Map(), plugins: getDefaultSerovalPlugins() }),
  );
}
