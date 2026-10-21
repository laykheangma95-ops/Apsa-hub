/**
 * Telegram reply + channel connect lifecycles — MOUNTED regressions.
 *
 * Mounts the REAL Conversation route (src/routes/app.inbox.$id.tsx) and the
 * REAL Settings → Telegram row in happy-dom and drives them like a merchant.
 * Only the network is replaced: the conversation read and the reply / connect
 * / disconnect calls return promises the test settles by hand, so a response
 * can arrive late — after a refresh, a draft edit, a thread switch or a
 * member/organization switch.
 *
 * Proves (PR #134 repair):
 *   - a refreshed server thread replaces an appended send result, so a
 *     sweep's failure and its Retry appear WITHOUT a remount;
 *   - an older send's completion never clears a newer draft, and a replay
 *     still 'sending' keeps the draft and its replay key (the next tap reuses
 *     the key);
 *   - a delayed reply result is dropped after a thread or principal switch,
 *     including a return to the same thread;
 *   - connect / disconnect carry the initiating principal and drop their UI
 *     effects after a principal switch;
 *   - timeout / sweep copy says "unconfirmed", never "not delivered", in
 *     English and Khmer.
 *
 * Runs in its own process (telegram-reply-mounted.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/inbox" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const id = (suffix: string) => `3f2504e0-4f89-41d3-9a0c-${suffix.padStart(12, "0")}`;

const routeContext = { session: { userId: id("a001") }, organizationId: id("b001") };
const routeParams = { id: id("c001") };
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => routeContext,
    useParams: () => ({ ...routeParams }),
  }),
  Link: ({ children, to: _to, ...rest }: any) => createElement("a", rest, children),
  useNavigate: () => () => {},
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app/inbox" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

// ── Network boundary ────────────────────────────────────────────────────────

interface Pending<T = any> {
  data: any;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
const sends: Pending[] = [];
/** The server's current view of each thread; tests mutate it to model a sweep. */
const threads: Record<string, any> = {};

function thread(cid: string, messages: any[] = []) {
  return {
    id: cid,
    customerId: "",
    customerName: "Sokha",
    channel: "telegram",
    provider: "TELEGRAM",
    status: "needs_reply",
    messages,
    nextBeforeId: null,
    readThroughMessageId: null,
  };
}

function outbound(mid: string, key: string, body: string, state: string, sendError?: string) {
  return {
    id: mid,
    direction: "outbound",
    body,
    at: "2026-10-20T03:00:00Z",
    state,
    messageType: "text",
    providerMessageId: `apsa:${key}`,
    ...(sendError ? { sendError } : {}),
  };
}

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getConversation: async (cid: string) => structuredClone(threads[cid]),
  getProducts: async () => [],
  getRecentProducts: async () => [],
  markRealConversationRead: async () => {},
  getOlderConversationMessages: async () => ({ messages: [], nextBeforeId: null }),
  getMostRecentRealOrderForCustomer: async () => null,
  sendRealConversationReply: (data: any) =>
    new Promise((resolve, reject) => sends.push({ data, resolve, reject })),
}));

const connects: Pending[] = [];
const disconnects: Pending[] = [];
let channelList: any[] = [];
mock.module("@/api/channels", () => ({
  listChannelConnectionsFn: async () => structuredClone(channelList),
  connectTelegramBotFn: ({ data }: any) =>
    new Promise((resolve, reject) => connects.push({ data, resolve, reject })),
  disconnectChannelFn: ({ data }: any) =>
    new Promise((resolve, reject) => disconnects.push({ data, resolve, reject })),
}));

const toasts: string[] = [];
const realFeedback = await import("@/lib/feedback");
mock.module("@/lib/feedback", () => ({
  ...realFeedback,
  notifySuccess: (message: string) => toasts.push(`ok:${message}`),
  notifyError: (message: string) => toasts.push(`error:${message}`),
}));

// ── Mount ───────────────────────────────────────────────────────────────────

const mediaQuery = (query: string) => ({
  matches: /prefers-reduced-motion:\s*reduce/.test(query),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = mediaQuery;
(globalThis as any).matchMedia = mediaQuery;
(window as any).HTMLElement.prototype.scrollIntoView = function () {};
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const km = (await import("@/locales/km.json")).default as any;
const { Route } = await import("@/routes/app.inbox.$id");
const ConversationScreen = (Route as any).component as () => React.ReactElement;
const { TelegramChannelRow } = await import("@/components/settings/TelegramChannelRow");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;
let currentTree: () => React.ReactElement = () => React.createElement("div");

const PERMISSIONS = [
  "messages.read",
  "messages.reply",
  "integrations.read",
  "integrations.connect",
  "integrations.disconnect",
] as const;

function wrap(child: React.ReactElement) {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(CapabilityFixtureProvider, { permissions: PERMISSIONS }, child),
  );
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(tree: () => React.ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  currentTree = tree;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(wrap(currentTree())));
  await settle(8);
}

async function rerender() {
  await act(async () => root!.render(wrap(currentTree())));
  await settle(8);
}

const text = () => document.body.textContent ?? "";

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input to type into");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** The delivery-state icons of the outbound bubbles, in order. */
const states = () =>
  [...document.querySelectorAll("svg[aria-label]")]
    .map((el) => el.getAttribute("aria-label"))
    .filter((label) => ["sending", "sent", "failed", "read", "delivered"].includes(label ?? ""));

const composer = () =>
  document.querySelector(
    `input[placeholder="${en.conversation.composerPlaceholder}"]`,
  ) as HTMLInputElement | null;

async function submitComposer() {
  const form = composer()!.closest("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function settleSend(index: number, value: any) {
  await act(async () => sends[index]!.resolve(value));
  await settle(8);
}

async function refreshThread() {
  await act(async () => {
    await client.invalidateQueries();
  });
  await settle(8);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  threads[id("c001")] = thread(id("c001"));
  threads[id("c002")] = thread(id("c002"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  sends.length = 0;
  connects.length = 0;
  disconnects.length = 0;
  toasts.length = 0;
  channelList = [];
  routeContext.session.userId = id("a001");
  routeContext.organizationId = id("b001");
  routeParams.id = id("c001");
});

const screen = () => React.createElement(ConversationScreen);

// ── Conversation: reconcile, draft, replay key, scope ───────────────────────

describe("Conversation reply lifecycle", () => {
  it("a sweep's failure and Retry appear after a refresh, without a remount", async () => {
    await mount(screen);
    await type(composer(), "Size M is in stock");
    await submitComposer();
    expect(sends).toHaveLength(1);
    const key = sends[0]!.data.clientMessageId;
    const sending = outbound(id("f001"), key, "Size M is in stock", "sending");
    threads[id("c001")].messages = [sending];
    await settleSend(0, { message: sending });

    // Negative control: while 'sending' there is no Retry and no failure copy.
    expect(button(en.conversation.retrySend)).toBeUndefined();
    expect(text()).not.toContain(en.conversation.replyError.unconfirmed);

    // The server sweeps it (send_stuck); the screen's periodic re-read runs.
    threads[id("c001")].messages = [
      outbound(id("f001"), key, "Size M is in stock", "failed", "send_stuck"),
    ];
    await refreshThread();
    expect(button(en.conversation.retrySend)).toBeDefined();
    expect(text()).toContain(en.conversation.replyError.unconfirmed);
    expect(text()).not.toContain(en.conversation.replyError.not_delivered);

    // Retry reuses the reply's own key.
    await click(button(en.conversation.retrySend), "retry");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.data.clientMessageId).toBe(key);
  });

  it("an older appended result never overrides a newer server row (and vice versa)", async () => {
    await mount(screen);
    await type(composer(), "Hello");
    await submitComposer();
    const key = sends[0]!.data.clientMessageId;
    // The server already moved on before the send result arrives…
    threads[id("c001")].messages = [outbound(id("f002"), key, "Hello", "sending")];
    await refreshThread();
    // …then the send result arrives ('sent' — newer than that snapshot; the
    // server committed it before answering). The stale 'sending' snapshot
    // does not win over it.
    threads[id("c001")].messages = [outbound(id("f002"), key, "Hello", "sent")];
    await settleSend(0, { message: outbound(id("f002"), key, "Hello", "sent") });
    expect(states()).toEqual(["sent"]);
    expect(button(en.conversation.retrySend)).toBeUndefined();
    // A LATER snapshot wins over that result again (it may carry a late change).
    threads[id("c001")].messages = [
      outbound(id("f002"), key, "Hello", "failed", "blocked_by_user"),
    ];
    await refreshThread();
    expect(states()).toEqual(["failed"]);
    expect(text()).toContain(en.conversation.replyError.blocked_by_user);
  });

  it("a replay that is still 'sending' keeps the draft and its key; the next tap reuses it", async () => {
    await mount(screen);
    await type(composer(), "Are you there?");
    await submitComposer();
    const key = sends[0]!.data.clientMessageId;
    await settleSend(0, { message: outbound(id("f003"), key, "Are you there?", "sending") });
    expect(composer()!.value).toBe("Are you there?");
    await submitComposer();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.data.clientMessageId).toBe(key);
    // Terminal 'sent' for THAT key: now the draft and key are released.
    await settleSend(1, { message: outbound(id("f003"), key, "Are you there?", "sent") });
    expect(composer()!.value).toBe("");
    await type(composer(), "Are you there?");
    await submitComposer();
    expect(sends[2]!.data.clientMessageId).not.toBe(key);
  });

  it("an older send completing never clears a newer draft", async () => {
    await mount(screen);
    await type(composer(), "first reply");
    await submitComposer();
    const key = sends[0]!.data.clientMessageId;
    await type(composer(), "second reply, still typing");
    await settleSend(0, { message: outbound(id("f004"), key, "first reply", "sent") });
    expect(composer()!.value).toBe("second reply, still typing");
    await submitComposer();
    expect(sends[1]!.data.clientMessageId).not.toBe(key);
    expect(sends[1]!.data.body).toBe("second reply, still typing");
  });

  it("a delayed result is dropped after a thread switch, even on return to the thread", async () => {
    await mount(screen);
    await type(composer(), "late reply");
    await submitComposer();
    const key = sends[0]!.data.clientMessageId;
    routeParams.id = id("c002");
    await rerender();
    routeParams.id = id("c001");
    await rerender();
    await settleSend(0, {
      message: outbound(id("f005"), key, "late reply", "failed", "blocked_by_user"),
      deliveryError: "blocked_by_user",
    });
    expect(text()).not.toContain(en.conversation.replyError.blocked_by_user);
    expect(text()).not.toContain("late reply");
  });

  it("a delayed result is dropped after a member or organization switch", async () => {
    for (const change of [
      () => (routeContext.session.userId = id("a002")),
      () => (routeContext.organizationId = id("b002")),
    ]) {
      await mount(screen);
      await type(composer(), "switch reply");
      await submitComposer();
      const sent = sends.at(-1)!;
      expect(sent.data.expectedPrincipal).toEqual({
        userId: id("a001"),
        organizationId: id("b001"),
      });
      change();
      await rerender();
      await act(async () =>
        sent.reject(new Error("The signed-in member or organization changed.")),
      );
      await settle(8);
      expect(text()).not.toContain(en.conversation.replyError.principal_changed);
      // The new principal's composer is clean and usable.
      expect(composer()!.value).toBe("");
      expect(button(en.conversation.send)?.getAttribute("aria-busy")).not.toBe("true");
      await act(async () => root?.unmount());
      document.body.innerHTML = "";
      routeContext.session.userId = id("a001");
      routeContext.organizationId = id("b001");
    }
  });

  it("timeouts read as unconfirmed in Khmer too, never as not delivered", async () => {
    await i18n.changeLanguage("km");
    threads[id("c001")].messages = [
      outbound(id("f006"), crypto.randomUUID(), "ok", "failed", "provider_unavailable"),
    ];
    await mount(screen);
    expect(text()).toContain(km.conversation.replyError.unconfirmed);
    expect(text()).not.toContain(km.conversation.replyError.not_delivered);
  });
});

// ── Settings → Telegram: principal-bound connect / disconnect ───────────────

describe("Telegram connect / disconnect", () => {
  const TOKEN = "7123456789:AAH-test_token_value_0123456789abcdefXYZ";
  const row = () =>
    React.createElement(TelegramChannelRow, {
      userId: routeContext.session.userId,
      organizationId: routeContext.organizationId,
    });

  async function openSheet() {
    const rowButton = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith(en.settings.channels.telegram.label),
    );
    await click(rowButton, "telegram row");
  }

  it("connect sends the initiating principal; its result is dropped after a principal switch", async () => {
    await mount(row);
    await openSheet();
    const input = document.getElementById("telegram-bot-token") as HTMLInputElement;
    await type(input, TOKEN);
    await click(button(en.settings.channels.telegram.connect), "connect");
    expect(connects).toHaveLength(1);
    expect(connects[0]!.data.expectedPrincipal).toEqual({
      userId: id("a001"),
      organizationId: id("b001"),
    });
    routeContext.organizationId = id("b002");
    await rerender();
    await act(async () => connects[0]!.resolve({ id: id("9001"), provider: "TELEGRAM" }));
    await settle(8);
    expect(toasts).toEqual([]);

    // Positive control: unchanged principal → the success effect runs.
    await openSheet();
    await type(document.getElementById("telegram-bot-token") as HTMLInputElement, TOKEN);
    await click(button(en.settings.channels.telegram.connect), "connect");
    expect(connects[1]!.data.expectedPrincipal.organizationId).toBe(id("b002"));
    await act(async () => connects[1]!.resolve({ id: id("9002"), provider: "TELEGRAM" }));
    await settle(8);
    expect(toasts).toEqual([`ok:${en.settings.channels.telegram.connected}`]);
  });

  it("a superseded connect shows its own copy", async () => {
    await mount(row);
    await openSheet();
    await type(document.getElementById("telegram-bot-token") as HTMLInputElement, TOKEN);
    await click(button(en.settings.channels.telegram.connect), "connect");
    await act(async () => connects[0]!.reject(new Error("connect_superseded")));
    await settle(8);
    expect(text()).toContain(en.settings.channels.telegram.connectError.connect_superseded);
  });

  it("disconnect sends the initiating principal; its result is dropped after a member switch", async () => {
    channelList = [
      {
        id: id("9003"),
        provider: "TELEGRAM",
        handle: "sokha_shop_bot",
        displayName: "Sokha Shop",
        status: "connected",
        connectedAt: "2026-10-20T03:00:00Z",
      },
    ];
    await mount(row);
    await openSheet();
    await click(button(en.settings.channels.telegram.disconnect), "disconnect");
    await click(button(en.settings.channels.telegram.disconnectAction), "confirm");
    expect(disconnects[0]!.data).toEqual({
      connectionId: id("9003"),
      expectedPrincipal: { userId: id("a001"), organizationId: id("b001") },
    });
    routeContext.session.userId = id("a002");
    await rerender();
    await act(async () => disconnects[0]!.reject(new Error("principal_changed")));
    await settle(8);
    expect(toasts).toEqual([]);
  });
});
