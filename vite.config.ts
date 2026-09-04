// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { ConfigEnv } from "vite";

const lovableConfig = defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});

// Vite picks the React JSX transform from `process.env.NODE_ENV`, not from the build mode.
// A deploy environment that carries NODE_ENV=development into the build therefore emits
// jsxDEV() calls into the SSR bundle while React itself is still resolved through its
// production condition — where `react/jsx-dev-runtime` exports `jsxDEV === undefined`.
// SSR then dies on the first render with "jsxDEV is not a function".
// Pin NODE_ENV for real production builds; `build:dev` (--mode development) is untouched.
export default (env: ConfigEnv) => {
  if (env.command === "build" && env.mode !== "development") {
    process.env["NODE_ENV"] = "production";
  }
  return lovableConfig(env);
};
