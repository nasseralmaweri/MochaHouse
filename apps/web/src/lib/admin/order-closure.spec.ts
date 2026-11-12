import type {
  CloseOrderResponse,
  OrderStatus,
  StoreOrderClosureSummary,
} from "@mocha-house/contracts";
import {
  EMPTY_CLOSURE_DRAFT,
  buildClosureRequest,
  closeStoreOrderFromBrowser,
  closureActionFor,
  closureExplanation,
  closureFlowAfter,
  closureOutcomeMessage,
  closureSummaryLines,
  type ClosureAction,
  type ClosureRequest,
  type ClosureResult,
} from "./order-closure";

// V1 launch fix 1 — reject / cancel from Order Details, against mocked API
// responses only (no payments, no server).

const ORDER = "01a1d0d0-0000-7000-8000-0000000000b1";
const LOC = "01a1d0b1-112c-758b-a108-7b511597e32b";

function reply(status: number, body?: unknown, unreadable = false): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () =>
      unreadable ? Promise.reject(new SyntaxError("bad json")) : Promise.resolve(body),
  } as unknown as Response;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const closure = (over: Partial<StoreOrderClosureSummary> = {}): StoreOrderClosureSummary => ({
  kind: "CANCELLED",
  fromStatus: "PREPARING",
  reasonCode: "CUSTOMER_REQUEST",
  reasonLabel: "The customer asked to cancel",
  note: null,
  closedAt: "2026-11-12T18:00:00.000Z",
  refundDueMinorUnits: 1500,
  refundStatus: "DUE",
  giftCardRestoredMinorUnits: 0,
  loyaltyShortfallBeans: 0,
  ...over,
});

const closed = (over: Partial<CloseOrderResponse> = {}): CloseOrderResponse => ({
  orderId: ORDER,
  status: "CANCELLED",
  closed: true,
  closure: closure(),
  ...over,
});

const reject = closureActionFor("RECEIVED")!;
const cancel = closureActionFor("PREPARING")!;

function built(
  action: ClosureAction,
  status: OrderStatus,
  reasonCode: string,
  note = "",
): ClosureRequest {
  const r = buildClosureRequest(
    action,
    { reasonCode: reasonCode as never, note },
    { locationId: LOC, status },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.request;
}

describe("which action an order offers", () => {
  it("rejects a RECEIVED order", () => {
    expect(reject).toMatchObject({ kind: "REJECTED", label: "Reject order" });
    expect(reject.reasons).toContain("STORE_TOO_BUSY");
    expect(reject.reasons).not.toContain("CUSTOMER_REQUEST");
  });
  it.each<OrderStatus>(["ACCEPTED", "PREPARING", "READY"])("cancels %s", (status) => {
    expect(closureActionFor(status)).toMatchObject({
      kind: "CANCELLED",
      label: "Cancel order",
    });
  });
  it.each<OrderStatus>(["COMPLETED", "REJECTED", "CANCELLED"])(
    "offers nothing for terminal %s",
    (status) => {
      expect(closureActionFor(status)).toBeNull();
    },
  );
});

describe("the confirmation form", () => {
  it("requires a reason from the action's own list", () => {
    const none = buildClosureRequest(reject, EMPTY_CLOSURE_DRAFT, { locationId: LOC, status: "RECEIVED" });
    expect(!none.ok && none.errors.reason).toBeTruthy();
    // A cancellation reason is not a rejection reason.
    const wrong = buildClosureRequest(
      reject,
      { reasonCode: "CUSTOMER_REQUEST", note: "" },
      { locationId: LOC, status: "RECEIVED" },
    );
    expect(!wrong.ok && wrong.errors.reason).toBeTruthy();
  });
  it("OTHER requires a note; notes are trimmed and capped", () => {
    const missing = buildClosureRequest(
      cancel,
      { reasonCode: "OTHER", note: "   " },
      { locationId: LOC, status: "READY" },
    );
    expect(!missing.ok && missing.errors.note).toMatch(/note/);
    const long = buildClosureRequest(
      cancel,
      { reasonCode: "OTHER", note: "x".repeat(501) },
      { locationId: LOC, status: "READY" },
    );
    expect(!long.ok && long.errors.note).toMatch(/500/);
    expect(built(cancel, "READY", "OTHER", "  wrong pickup time  ")).toEqual({
      kind: "CANCELLED",
      body: {
        locationId: LOC,
        expectedStatus: "READY",
        reasonCode: "OTHER",
        note: "wrong pickup time",
      },
    });
  });
  it("a rejection carries no expected status; a cancellation carries the status staff saw", () => {
    expect(built(reject, "RECEIVED", "STORE_TOO_BUSY")).toEqual({
      kind: "REJECTED",
      body: { locationId: LOC, reasonCode: "STORE_TOO_BUSY" },
    });
    expect(built(cancel, "ACCEPTED", "CUSTOMER_REQUEST").body).toMatchObject({
      expectedStatus: "ACCEPTED",
    });
  });
  it("explains, before confirming, that the card is NOT refunded", () => {
    const text = closureExplanation("CANCELLED").join(" ");
    expect(text).toMatch(/does NOT refund the customer's card/);
    expect(text).toMatch(/card refund owed/);
    expect(closureExplanation("REJECTED").join(" ")).toMatch(/does NOT refund/);
  });
});

describe("sending", () => {
  it("posts the reject / cancel route with the request unchanged", async () => {
    fetchMock.mockResolvedValue(reply(200, closed({ status: "REJECTED" })));
    const r = built(reject, "RECEIVED", "DUPLICATE_ORDER");
    expect((await closeStoreOrderFromBrowser(ORDER, r)).outcome).toBe("success");
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/internal/admin/orders/${ORDER}/reject`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(r.body);

    fetchMock.mockResolvedValue(reply(200, closed()));
    const c = built(cancel, "PREPARING", "CUSTOMER_REQUEST");
    await closeStoreOrderFromBrowser(ORDER, c);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/internal/admin/orders/${ORDER}/cancel`);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(c.body);
    // The proxy's CSRF marker is on every closure request (without it the
    // web proxy refuses the call with 403).
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("x-centerivo-request")).toBe("1");
    }
    // Never a refund route: closing does not refund a card.
    expect(fetchMock.mock.calls.every(([url]) => !/refunds/.test(url))).toBe(true);
  });

  it("maps every refusal", async () => {
    const r = built(cancel, "READY", "STORE_CLOSING");
    const cases: [Response, ClosureResult["outcome"]][] = [
      [reply(403), "forbidden"],
      [reply(404, { message: "Order rejection and cancellation are not available." }), "disabled"],
      [reply(404, { message: "Order not found for this location." }), "not-found"],
      [reply(409, { message: "Order status changed since this action was requested (now COMPLETED)." }), "conflict"],
      [reply(400, { message: "A note is required when the reason is OTHER." }), "invalid"],
      [reply(503, { message: "This order is busy right now." }), "busy"],
      [reply(500), "uncertain"],
      [reply(429), "uncertain"],
      [reply(200, undefined, true), "uncertain"],
      [reply(200, { nope: true }), "uncertain"],
    ];
    for (const [res, outcome] of cases) {
      fetchMock.mockResolvedValueOnce(res);
      expect((await closeStoreOrderFromBrowser(ORDER, r)).outcome).toBe(outcome);
    }
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect((await closeStoreOrderFromBrowser(ORDER, r)).outcome).toBe("uncertain");
  });
});

describe("after a result", () => {
  const r = built(cancel, "READY", "STORE_CLOSING");

  it("success reloads the order; a replay says nothing changed again", () => {
    expect(closureFlowAfter(r, { outcome: "success", data: closed() })).toEqual({
      flow: { step: "done", replayed: false },
      reload: true,
    });
    const replay = closureFlowAfter(r, { outcome: "success", data: closed({ closed: false }) });
    expect(replay.flow).toEqual({ step: "done", replayed: true });
    expect(closureOutcomeMessage("CANCELLED", true)).toMatch(/already been cancelled/);
    expect(closureOutcomeMessage("REJECTED", false)).toBe("Order rejected.");
  });

  it("a timeout keeps the SAME request to retry (the API replays, never closes twice)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("timeout"));
    const first = await closeStoreOrderFromBrowser(ORDER, r);
    const next = closureFlowAfter(r, first);
    expect(next).toEqual({
      flow: { step: "retry", request: r, message: expect.any(String) as unknown },
      reload: false,
    });
    fetchMock.mockResolvedValueOnce(reply(200, closed({ closed: false })));
    if (next.flow.step !== "retry") throw new Error("expected retry");
    await closeStoreOrderFromBrowser(ORDER, next.flow.request);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it("a busy order (503) can be retried as is", () => {
    expect(closureFlowAfter(r, { outcome: "busy", message: "Busy." }).flow).toMatchObject({
      step: "retry",
      request: r,
    });
  });

  it("a stale status (409) refreshes the order and drops the request", () => {
    const next = closureFlowAfter(r, { outcome: "conflict", message: "Order status changed." });
    expect(next.reload).toBe(true);
    expect(next.flow.step).toBe("closed-form");
    expect(next.flow.step === "closed-form" && next.flow.notice).toMatch(/refreshed/);
  });

  it("unauthorized, disabled and wrong location are explained", () => {
    expect(closureFlowAfter(r, { outcome: "forbidden" }).flow).toMatchObject({
      notice: expect.stringMatching(/permission/) as unknown,
    });
    expect(closureFlowAfter(r, { outcome: "disabled" }).flow).toMatchObject({
      notice: expect.stringMatching(/isn't switched on/) as unknown,
    });
    expect(closureFlowAfter(r, { outcome: "not-found" }).flow).toMatchObject({
      notice: expect.stringMatching(/wasn't found at this location/) as unknown,
    });
    expect(closureFlowAfter(r, { outcome: "invalid", message: "Bad." }).flow).toEqual({
      step: "form",
      notice: "Bad.",
    });
  });
});

describe("the closure summary", () => {
  it("shows the card refund owed (recorded, not refunded)", () => {
    const lines = closureSummaryLines(closure(), "USD", "Mocha Beans");
    expect(lines).toContainEqual({ label: "Card amount owed at closing", value: "$15.00", emphasis: true });
    expect(lines).toContainEqual({ label: "Reason", value: "The customer asked to cancel" });
    expect(lines).toContainEqual({ label: "Was", value: "Preparing" });
  });
  it("says when nothing was charged to a card, and shows reversals", () => {
    const lines = closureSummaryLines(
      closure({
        kind: "REJECTED",
        refundDueMinorUnits: 0,
        refundStatus: null,
        giftCardRestoredMinorUnits: 800,
        loyaltyShortfallBeans: 12,
      }),
      "USD",
      "Mocha Beans",
    );
    expect(lines).toContainEqual({
      label: "Card amount owed at closing",
      value: "None (nothing was charged to a card)",
    });
    expect(lines).toContainEqual({ label: "Gift card restored", value: "$8.00" });
    expect(lines).toContainEqual({ label: "Mocha Beans not recovered", value: "12" });
    expect(lines.find((l) => l.label === "Was")).toBeUndefined();
  });
});
