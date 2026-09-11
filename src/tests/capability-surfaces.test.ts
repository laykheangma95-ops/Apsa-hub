/**
 * Role-aware UI surfaces — structural regression tests.
 *
 * One test per high-value surface, asserting that the entry point is gated on
 * the SAME permission key its server function requires. If someone later
 * changes the server key without changing the UI, or drops the gate entirely,
 * these fail.
 *
 * They are source-level on purpose: the point is the wiring, and the behaviour
 * of the gate itself is covered by capability-model.test.ts.
 *
 * Run: bun test src/tests/capability-surfaces.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

/**
 * Each surface: the file, the permission key it gates on, and the server file
 * that enforces the same key. Both halves are asserted, so the pair cannot
 * drift apart silently.
 */
const SURFACES: Array<{
  name: string;
  uiFile: string;
  key: string;
  serverFile: string;
}> = [
  {
    name: "Orders list",
    uiFile: "src/routes/app.orders.tsx",
    key: "orders.read",
    serverFile: "src/server/orders/service.ts",
  },
  {
    name: "Order detail — confirm",
    uiFile: "src/routes/app.orders.$id.tsx",
    key: "orders.confirm",
    serverFile: "src/server/orders/state-machine.ts",
  },
  {
    name: "Order detail — cancel",
    uiFile: "src/routes/app.orders.$id.tsx",
    key: "orders.cancel",
    serverFile: "src/server/orders/state-machine.ts",
  },
  {
    name: "Home — add product quick action",
    uiFile: "src/routes/app.index.tsx",
    key: "products.create",
    serverFile: "src/server/products/service.ts",
  },
  {
    name: "Orders list — new order action",
    uiFile: "src/routes/app.orders.tsx",
    key: "orders.create",
    serverFile: "src/server/orders/service.ts",
  },
  {
    name: "Deliveries list",
    uiFile: "src/routes/app.deliveries.tsx",
    key: "delivery.read",
    serverFile: "src/server/deliveries/service.ts",
  },
  {
    name: "POS entry",
    uiFile: "src/routes/app.pos.tsx",
    key: "orders.create",
    serverFile: "src/server/orders/service.ts",
  },
  {
    name: "Team roster",
    uiFile: "src/routes/app.team.tsx",
    key: "team.read",
    serverFile: "src/server/team/service.ts",
  },
  {
    name: "Team invite",
    uiFile: "src/routes/app.team.tsx",
    key: "team.invite",
    serverFile: "src/server/team/service.ts",
  },
  {
    name: "Team role change",
    uiFile: "src/components/team/StaffDetailSheet.tsx",
    key: "team.roles_assign",
    serverFile: "src/server/team/service.ts",
  },
  {
    name: "Team removal",
    uiFile: "src/components/team/StaffDetailSheet.tsx",
    key: "team.remove",
    serverFile: "src/server/team/service.ts",
  },
  {
    name: "Settings — Business profile",
    uiFile: "src/routes/app.settings.tsx",
    key: "organization.read",
    serverFile: "src/server/org/get-organization-profile.ts",
  },
  {
    name: "Settings — Team entry",
    uiFile: "src/routes/app.settings.tsx",
    key: "team.read",
    serverFile: "src/server/team/service.ts",
  },
  {
    name: "Conversation — reply",
    uiFile: "src/routes/app.inbox.$id.tsx",
    key: "messages.reply",
    serverFile: "src/server/conversations/service.ts",
  },
  {
    name: "Conversation — create order",
    uiFile: "src/routes/app.inbox.$id.tsx",
    key: "orders.create",
    serverFile: "src/server/orders/service.ts",
  },
  {
    name: "Conversation — customer record",
    uiFile: "src/routes/app.inbox.$id.tsx",
    key: "customers.read",
    serverFile: "src/server/customers/service.ts",
  },
  {
    name: "Order detail — refund",
    uiFile: "src/routes/app.orders.$id.tsx",
    key: "payments.refund",
    serverFile: "src/server/payments/service.ts",
  },
  {
    name: "Order detail — customer phone",
    uiFile: "src/routes/app.orders.$id.tsx",
    key: "customers.view_sensitive",
    serverFile: "src/server/customers/service.ts",
  },
  {
    name: "Delivery detail — customer address",
    uiFile: "src/routes/app.deliveries.$id.tsx",
    key: "customers.view_sensitive",
    serverFile: "src/server/customers/service.ts",
  },
];

describe("each gated surface uses the key its server function enforces", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} gates on ${surface.key}`, () => {
      expect(read(surface.uiFile)).toContain(`"${surface.key}"`);
      expect(read(surface.serverFile)).toContain(`"${surface.key}"`);
    });
  }
});

describe("gated surfaces read capabilities from the one shared hook", () => {
  const uiFiles = [...new Set(SURFACES.map((surface) => surface.uiFile))];

  for (const file of uiFiles) {
    it(`${file} uses useCapabilities()`, () => {
      const source = read(file);
      expect(source).toContain('from "@/hooks/use-capabilities"');
      expect(source).toContain("useCapabilities()");
    });
  }
});

describe("denied surfaces stay non-leaky", () => {
  it("the shared denied state renders no organization, count or record data", () => {
    const source = read("src/components/common/CapabilityDeniedState.tsx");
    expect(source).toContain("capability.denied.title");
    expect(source).toContain("capability.unavailable.title");

    // Code only — the doc comment above it is allowed to say the words.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/useQuery|organizationId|\bcount\b|\bcustomer\b|\border\b/i);
  });

  it("the Deliveries denied branch returns before the search box and filters render", () => {
    const source = read("src/routes/app.deliveries.tsx");
    const deniedIdx = source.indexOf("if (!canReadDeliveries) {");
    const searchIdx = source.indexOf("deliveryList.searchPlaceholder");
    expect(deniedIdx).toBeGreaterThan(-1);
    expect(deniedIdx).toBeLessThan(searchIdx);
  });

  it("gated screens do not fetch the data they are not allowed to show", () => {
    expect(read("src/routes/app.orders.tsx")).toContain("enabled: !detailOpen && canReadOrders");
    expect(read("src/routes/app.deliveries.tsx")).toContain(
      "enabled: !detailOpen && canReadDeliveries",
    );
    expect(read("src/routes/app.team.tsx")).toContain("enabled: canReadTeam");
    expect(read("src/routes/app.pos.tsx")).toContain("enabled: canSell");
    expect(read("src/routes/app.settings.tsx")).toContain("enabled: canRead");
  });
});

describe("both locales carry the capability copy", () => {
  const en = JSON.parse(read("src/locales/en.json"));
  const km = JSON.parse(read("src/locales/km.json"));

  it("Khmer and English both define every capability string", () => {
    for (const locale of [en, km]) {
      expect(locale.capability.denied.title).toBeTruthy();
      expect(locale.capability.denied.body).toBeTruthy();
      expect(locale.capability.actionDenied).toBeTruthy();
      expect(locale.capability.unavailable.title).toBeTruthy();
      expect(locale.capability.unavailable.body).toBeTruthy();
    }
  });

  it("the Khmer copy is actually Khmer, not an English placeholder", () => {
    const khmer = /[ក-៿]/;
    expect(km.capability.denied.title).toMatch(khmer);
    expect(km.capability.denied.body).toMatch(khmer);
    expect(km.capability.actionDenied).toMatch(khmer);
    expect(km.capability.unavailable.title).toMatch(khmer);
    expect(km.capability.unavailable.body).toMatch(khmer);
  });
});
