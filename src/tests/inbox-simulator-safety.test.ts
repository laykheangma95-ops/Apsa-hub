/**
 * Inbox simulator safety boundary (PR #81).
 * Run: bun test src/tests/inbox-simulator-safety.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { inboxSimulatorEnabled } from "@/simulator/inbox/gate";
import {
  initialSimState,
  SIM_CUSTOMERS,
  SIM_PRODUCTS,
  simReducer,
  type SimState,
} from "@/simulator/inbox/model";
import { Route } from "@/routes/design.inbox-simulator";

const root = path.resolve(import.meta.dir, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const SIM_FILES = [
  "src/simulator/inbox/gate.ts",
  "src/simulator/inbox/model.ts",
  "src/simulator/inbox/InboxSimulator.tsx",
  "src/routes/design.inbox-simulator.tsx",
];

const env = process.env as Record<string, string | undefined>;
const saved = { PROD: env["PROD"], DEV: env["DEV"] };
afterEach(() => {
  for (const k of ["PROD", "DEV"] as const) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("gate", () => {
  it("enabled only for an explicit dev build", () => {
    expect(inboxSimulatorEnabled({ DEV: true, PROD: false })).toBe(true);
    expect(inboxSimulatorEnabled({ DEV: "true" })).toBe(true);
  });
  it("disabled in production", () => {
    expect(inboxSimulatorEnabled({ DEV: true, PROD: true })).toBe(false);
    expect(inboxSimulatorEnabled({ DEV: false, PROD: true })).toBe(false);
    expect(inboxSimulatorEnabled({ PROD: "true" })).toBe(false);
  });
  it("missing config = disabled", () => {
    expect(inboxSimulatorEnabled({})).toBe(false);
    expect(inboxSimulatorEnabled(undefined as never)).toBe(false);
    expect(inboxSimulatorEnabled(null as never)).toBe(false);
  });
  it("unexpected values = disabled", () => {
    for (const v of ["1", "yes", "TRUE", 1, {}, [], "", null]) {
      expect(inboxSimulatorEnabled({ DEV: v })).toBe(false);
    }
  });
});

describe("route", () => {
  it("direct navigation fails closed when not a dev build", () => {
    env["PROD"] = "true";
    delete env["DEV"];
    const before = (Route.options as { beforeLoad?: () => void }).beforeLoad!;
    expect(() => before()).toThrow();
  });
  it("fails closed when env is unset (bun test has no DEV)", () => {
    delete env["PROD"];
    delete env["DEV"];
    const before = (Route.options as { beforeLoad?: () => void }).beforeLoad!;
    expect(() => before()).toThrow();
  });
  it("guard lives in beforeLoad and the component is dynamically imported only under DEV", () => {
    const src = code("src/routes/design.inbox-simulator.tsx");
    expect(src).toContain("beforeLoad");
    expect(src).toContain("import.meta.env.DEV");
    expect(src).not.toMatch(/^import .*InboxSimulator"/m);
  });
  it("nothing outside the simulator references it (no nav, no production import)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !p.includes("/tests/")) {
          const s = fs.readFileSync(p, "utf8");
          if (/simulator\/inbox|inbox-simulator/.test(s)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "src"));
    expect(hits.sort()).toEqual(["src/routeTree.gen.ts", "src/routes/design.inbox-simulator.tsx"]);
  });
});

describe("isolation", () => {
  it("simulator files import nothing that can reach production paths", () => {
    const forbidden =
      /from\s+["'](@\/lib\/(api|mock|supabase)|@\/server|@\/api|@\/integrations|@tanstack\/react-query|@supabase)|createServerFn|localStorage|sessionStorage|indexedDB|fetch\(|useMutation|useQuery|create_order|supabase/i;
    for (const f of SIM_FILES) expect(code(f)).not.toMatch(forbidden);
  });
});

describe("local state behaviour", () => {
  const at = "2026-01-02T00:00:00.000Z";
  const open = (s: SimState, id = "sim_conv_001") =>
    simReducer(s, { type: "open", conversationId: id });

  it("open clears unread and moves unread->needs_reply", () => {
    const s = open(initialSimState());
    const c = s.conversations.find((x) => x.id === "sim_conv_001")!;
    expect(c.unread).toBe(0);
    expect(c.status).toBe("needs_reply");
  });
  it("receive/reply/status touch only simulator conversations", () => {
    let s = initialSimState();
    s = simReducer(s, { type: "receive", conversationId: "sim_conv_003", text: "hi", at });
    expect(s.conversations.find((c) => c.id === "sim_conv_003")!.status).toBe("unread");
    s = simReducer(s, { type: "reply", conversationId: "sim_conv_003", text: "yo", at });
    const c3 = s.conversations.find((c) => c.id === "sim_conv_003")!;
    expect(c3.status).toBe("waiting_customer");
    expect(c3.unread).toBe(0);
    s = simReducer(s, { type: "setStatus", conversationId: "sim_conv_003", status: "closed" });
    expect(s.conversations.find((c) => c.id === "sim_conv_003")!.status).toBe("closed");
    expect(s.conversations.find((c) => c.id === "sim_conv_001")!.messages.length).toBe(2);
  });
  it("blank messages are ignored", () => {
    const s = initialSimState();
    expect(simReducer(s, { type: "reply", conversationId: "sim_conv_001", text: "  ", at })).toBe(
      s,
    );
  });
  it("simulated order is local, linked, integer money, and does not touch stock/payment/delivery", () => {
    const s = simReducer(initialSimState(), {
      type: "createOrder",
      conversationId: "sim_conv_002",
      productId: "sim_product_001",
      quantity: 2,
      at,
    });
    const o = s.orders[0]!;
    expect(o).toMatchObject({
      id: "sim_order_001",
      customerId: "sim_customer_002",
      conversationId: "sim_conv_002",
      simulated: true,
      currency: "KHR",
    });
    expect(Number.isInteger(o.totalMinor)).toBe(true);
    expect(o.totalMinor).toBe(5000000);
    expect(s.conversations.find((c) => c.id === "sim_conv_002")!.status).toBe("order_created");
    expect(Object.keys(s).sort()).toEqual(["conversations", "orders", "seq"]);
    expect(Object.keys(o)).not.toContain("payment");
    expect(Object.keys(o)).not.toContain("delivery");
  });
  it("invalid orders are rejected", () => {
    const s = initialSimState();
    for (const [productId, quantity, conversationId] of [
      ["nope", 1, "sim_conv_001"],
      ["sim_product_001", 0, "sim_conv_001"],
      ["sim_product_001", 1000, "sim_conv_001"],
      ["sim_product_001", 1, "missing"],
    ] as const) {
      expect(simReducer(s, { type: "createOrder", conversationId, productId, quantity, at })).toBe(
        s,
      );
    }
  });
  it("reset clears everything", () => {
    let s = initialSimState();
    s = simReducer(s, {
      type: "createOrder",
      conversationId: "sim_conv_001",
      productId: "sim_product_001",
      quantity: 1,
      at,
    });
    s = simReducer(s, { type: "reply", conversationId: "sim_conv_001", text: "x", at });
    expect(simReducer(s, { type: "reset" })).toEqual(initialSimState());
  });
});

describe("synthetic data", () => {
  it("all ids and identities are obviously fake", () => {
    const s = initialSimState();
    for (const c of s.conversations) {
      expect(c.id).toMatch(/^sim_conv_\d+$/);
      expect(c.customerId).toMatch(/^sim_customer_\d+$/);
      for (const m of c.messages) expect(m.id).toMatch(/^sim_msg_\d+$/);
    }
    for (const c of SIM_CUSTOMERS) {
      expect(c.id).toMatch(/^sim_customer_\d+$/);
      expect(c.phone).toMatch(/^000 000 \d{3}$/);
      expect(c.name).toMatch(/^Simulated/);
    }
    for (const p of SIM_PRODUCTS) expect(p.id).toMatch(/^sim_product_\d+$/);
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });
});
