/**
 * The custody guard's cancellation refusal survives the real server-function
 * wire (src/tests/helpers/server-fn-wire.ts: the APSA boundary, then TanStack's
 * ShallowErrorPlugin both ways), and nothing else is mistaken for one.
 */
import { describe, expect, it } from "bun:test";
import {
  ORDER_CANCEL_BLOCKED_CODES,
  formatOrderCancelBlockedMessage,
  orderCancelBlockedCodeOf,
} from "@/lib/order-cancel-blocked";
import { orderCancelBlockedReason } from "@/lib/orders";
import { INTERNAL_ERROR_MESSAGE } from "@/lib/public-error";
import { publicError } from "@/server/public-domain-error";
import { overServerFnWire } from "./helpers/server-fn-wire";

const REASONS = {
  order_cancel_goods_with_customer: "goods_with_customer",
  order_cancel_goods_dispatched: "goods_dispatched",
  order_cancel_active_delivery: "active_delivery",
  order_cancel_blocked: "blocked",
} as const;

describe("custody refusal over the server-function wire", () => {
  for (const code of ORDER_CANCEL_BLOCKED_CODES) {
    it(`${code}: only the message crosses, and it still names the reason`, async () => {
      const received = await overServerFnWire(
        publicError(
          formatOrderCancelBlockedMessage(code, "This order cannot be cancelled"),
          409,
          code,
        ),
      );
      expect(received).toBeInstanceOf(Error);
      expect((received as { code?: unknown }).code).toBeUndefined();
      expect((received as { statusCode?: unknown }).statusCode).toBeUndefined();
      expect(orderCancelBlockedReason(received)).toBe(REASONS[code]);
    });
  }

  it("a `code` property alone never crosses: the old contract reads nothing", async () => {
    const received = await overServerFnWire(
      publicError("This order cannot be cancelled", 409, "order_cancel_goods_with_customer"),
    );
    expect(orderCancelBlockedReason(received)).toBeNull();
  });

  it("an unexpected error carrying a custody code is sanitized and stays generic", async () => {
    const received = await overServerFnWire(
      Object.assign(new Error("order_cancel_goods_with_customer: relation orders_pkey"), {
        statusCode: 409,
        code: "order_cancel_goods_with_customer",
      }),
    );
    expect((received as Error).message.startsWith(INTERNAL_ERROR_MESSAGE)).toBe(true);
    expect((received as Error).message).not.toContain("orders_pkey");
    expect(orderCancelBlockedReason(received)).toBeNull();
  });

  it("the code is read only from the start of the message, and only the known codes", () => {
    expect(orderCancelBlockedCodeOf("order_cancel_active_delivery: x")).toBe(
      "order_cancel_active_delivery",
    );
    expect(orderCancelBlockedCodeOf("Refused (order_cancel_active_delivery: x)")).toBeNull();
    expect(orderCancelBlockedCodeOf(" order_cancel_active_delivery: x")).toBeNull();
    expect(orderCancelBlockedCodeOf("order_cancel_active_delivery:x")).toBeNull();
    expect(orderCancelBlockedCodeOf("order_cancel_everything: x")).toBeNull();
    expect(
      orderCancelBlockedCodeOf("This order cannot be cancelled while a delivery is arranged"),
    ).toBeNull();
    expect(orderCancelBlockedReason("order_cancel_active_delivery: x")).toBeNull(); // not an Error
    expect(orderCancelBlockedReason(null)).toBeNull();
  });
});
