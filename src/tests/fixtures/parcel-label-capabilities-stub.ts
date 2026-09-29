/**
 * The `@/api/capabilities` server function, replaced by an in-page "server" for
 * the parcel-label revocation browser fixture ONLY (aliased in
 * src/tests/parcel-label-revocation.browser.ts; unreachable from any build).
 *
 * The shipped <CapabilityProvider>, its query, cache and polling all run for
 * real. Only the network hop is local, and the grant lives HERE — on the
 * "server" side — so a revocation is a server-side change that the client
 * must discover through the production query path, never a React prop swap.
 * `getParcelLabelData` in parcel-label-api-stub.ts consults the same state, so
 * the "server" refuses a label read exactly when the grant is gone.
 */
import type { CapabilityResult, UiPermissionKey } from "@/lib/capabilities";

export const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
export const ORG_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";
export const ALL_GRANTED: UiPermissionKey[] = [
  "orders.read",
  "orders.update",
  "fulfillment.print_label",
];

interface FakeServer {
  permissions: UiPermissionKey[];
  /** When true the capability endpoint rejects (network/5xx). */
  capabilityFails: boolean;
  /** Serve a snapshotless (unconfirmed) order with no recipient data. */
  snapshotless: boolean;
  capabilityRequests: number;
  labelFetches: string[];
  printCalls: number;
  revoke(): void;
  grant(): void;
}

declare global {
  interface Window {
    apsaServer: FakeServer;
  }
}

const server: FakeServer = {
  permissions: [...ALL_GRANTED],
  capabilityFails: false,
  snapshotless: false,
  capabilityRequests: 0,
  labelFetches: [],
  printCalls: 0,
  revoke() {
    server.permissions = server.permissions.filter((p) => p !== "fulfillment.print_label");
  },
  grant() {
    server.permissions = [...ALL_GRANTED];
  },
};
window.apsaServer = server;
// Count print attempts without opening a real print dialog.
window.print = () => {
  server.printCalls += 1;
};

export async function getActiveMemberCapabilitiesFn(): Promise<CapabilityResult> {
  server.capabilityRequests += 1;
  await Promise.resolve();
  if (server.capabilityFails) throw new Error("capability endpoint unavailable");
  return {
    status: "active",
    userId: USER_ID,
    organizationId: ORG_ID,
    role: "STAFF",
    permissions: [...server.permissions],
  };
}
