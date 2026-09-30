import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { installNavigationTiming } from "./lib/perf/navigation-timing";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  // Staging/development diagnostics only: a no-op unless the build sets
  // VITE_APSA_PERF_NAV_TIMING=true, and always a no-op on the server.
  installNavigationTiming(router);

  return router;
};
