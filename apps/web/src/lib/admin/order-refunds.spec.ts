import type {
  CreateOrderRefundRequest,
  OrderRefundBalances,
  OrderRefundObligationListItem,
  OrderRefundObligationView,
  OrderRefundsResponse,
  OrderRefundView,
} from "@mocha-house/contracts";
import {
  EMPTY_DRAFT,
  buildRefundRequest,
  canRecheck,
  clearPendingRefund,
  closedOrderLine,
  expectedReservedOf,
  flowAfter,
  getOrderRefundsFromBrowser,
  getRefundObligationsFromBrowser,
  loadPendingRefund,
  needsLateFailureReview,
  obligationStatusLabel,
  obligationsOwedFirst,
  parseRefundAmount,
  recheckOrderRefundFromBrowser,
  refundAccess,
  refundOutcomeMessage,
  refundStatusView,
  requestOrderRefundFromBrowser,
  reviewOrderRefundFromBrowser,
  savePendingRefund,
  validateDraft,
  validateReviewNote,
  type RefundActionResult,
} from "./order-refunds";

// ESP-04 M5d — the staff refund interface's rules, against mocked API
// responses only (no Stripe, no server).

const ORDER = "01a0db02-f800-7000-8000-0000000000d1";
const LOC = "01a0db02-f800-7000-8000-0000000000aa";

const balances = (over: Partial<OrderRefundBalances> = {}): OrderRefundBalances => ({
  chargedMinorUnits: 2000,
  refundedMinorUnits: 0,
  inProgressMinorUnits: 0,
  refundableMinorUnits: 2000,
  lateFailureNeedsReview: false,
  unresolved: false,
  ...over,
});

const refund = (over: Partial<OrderRefundView> = {}): OrderRefundView => ({
  id: "r1",
  origin: "CENTERIVO",
  status: "SUCCEEDED",
  amountMinorUnits: 500,
  currency: "USD",
  reasonCode: "CUSTOMER_REQUEST",
  reasonLabel: "Customer request",
  note: null,
  requestedBy: { id: "u1", displayName: "Sam" },
  createdAt: "2026-11-01T10:00:00.000Z",
  succeededAt: "2026-11-01T10:00:01.000Z",
  failedAfterSuccessAt: null,
  lateFailureReviewedAt: null,
  lateFailureReviewNote: null,
  notCreatedEvidence: null,
  ...over,
});

const obligation = (
  over: Partial<OrderRefundObligationView> = {},
): OrderRefundObligationView => ({
  amountMinorUnits: 2000,
  recordedStatus: "DUE",
  refundedMinorUnits: 0,
  inProgressMinorUnits: 0,
  outstandingMinorUnits: 2000,
  fullyRefunded: false,
  needsAttention: false,
  ...over,
});

const response = (over: Partial<OrderRefundsResponse> = {}): OrderRefundsResponse => ({
  orderId: ORDER,
  orderStatus: "COMPLETED",
  currency: "USD",
  refundsEnabled: true,
  balances: balances(),
  obligation: null,
  refunds: [],
  attentionRefundIds: [],
  paymentNeedsAttention: false,
  ...over,
});

const request = (over: Partial<CreateOrderRefundRequest> = {}): CreateOrderRefundRequest => ({
  locationId: LOC,
  requestId: "11111111-1111-4111-8111-111111111111",
  amountMinorUnits: 2000,
  currency: "USD",
  reasonCode: "CUSTOMER_REQUEST",
  expectedReservedMinorUnits: 0,
  ...over,
});

function reply(status: number, body?: unknown, raw?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () =>
      raw !== undefined
        ? Promise.reject(new SyntaxError("bad json"))
        : Promise.resolve(body),
  } as unknown as Response;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("amounts in minor units (never floating point)", () => {
  it("parses typed amounts exactly", () => {
    expect(parseRefundAmount("12.34", "USD")).toBe(1234);
    expect(parseRefundAmount("0.10", "USD")).toBe(10);
    expect(parseRefundAmount("0.29", "USD")).toBe(29); // 0.29*100 = 28.999… in floats
    expect(parseRefundAmount("$1,005.5", "USD")).toBe(100550);
    expect(parseRefundAmount("7", "USD")).toBe(700);
  });
  it("refuses anything that is not a plain positive amount", () => {
    expect(parseRefundAmount("1,005", "USD")).toBe(100500);
    for (const bad of [
      "",
      "0",
      "0.00",
      "-1",
      "1.234",
      "abc",
      "1e3",
      "1.2.3",
      "9999999999",
      "4,50", // a decimal comma is never read as 450
      "1,0,0",
      "12,34.5",
      "€5", // only the currency's own symbol
    ]) {
      expect(parseRefundAmount(bad, "USD")).toBeNull();
    }
  });
  it("expected reserved is what the server reported as refunded + in progress", () => {
    expect(expectedReservedOf(balances({ refundedMinorUnits: 300, inProgressMinorUnits: 200 }))).toBe(500);
  });
});

describe("the refund form", () => {
  it("full remaining refund: the server's maximum, with a reason", () => {
    const v = validateDraft({ ...EMPTY_DRAFT, reasonCode: "WRONG_ORDER" }, 1500, "USD");
    expect(v).toEqual({
      ok: true,
      value: { amountMinorUnits: 1500, reasonCode: "WRONG_ORDER", note: undefined },
    });
  });
  it("partial refund: the typed amount, never more than the maximum", () => {
    const ok = validateDraft(
      { mode: "partial", amountInput: "4.50", reasonCode: "MISSING_ITEM", note: "  one latte  " },
      1500,
      "USD",
    );
    expect(ok).toEqual({
      ok: true,
      value: { amountMinorUnits: 450, reasonCode: "MISSING_ITEM", note: "one latte" },
    });
    const over = validateDraft(
      { mode: "partial", amountInput: "15.01", reasonCode: "MISSING_ITEM", note: "" },
      1500,
      "USD",
    );
    expect(over.ok).toBe(false);
    expect(!over.ok && over.errors.amount).toMatch(/At most \$15\.00/);
  });
  it("needs a reason, and a note for Other", () => {
    const v = validateDraft({ ...EMPTY_DRAFT }, 1000, "USD");
    expect(!v.ok && v.errors.reason).toBeTruthy();
    const other = validateDraft({ ...EMPTY_DRAFT, reasonCode: "OTHER", note: "   " }, 1000, "USD");
    expect(!other.ok && other.errors.note).toBeTruthy();
    const long = validateDraft(
      { ...EMPTY_DRAFT, reasonCode: "GOODWILL", note: "x".repeat(501) },
      1000,
      "USD",
    );
    expect(!long.ok && long.errors.note).toBeTruthy();
  });
  it("builds one request from the last server figures, with the given request id", () => {
    const built = buildRefundRequest(
      { amountMinorUnits: 450, reasonCode: "MISSING_ITEM", note: "one latte" },
      {
        locationId: LOC,
        currency: "usd",
        balances: balances({ refundedMinorUnits: 300, inProgressMinorUnits: 100 }),
        requestId: "req-1",
      },
    );
    expect(built).toEqual({
      locationId: LOC,
      requestId: "req-1",
      amountMinorUnits: 450,
      currency: "USD",
      reasonCode: "MISSING_ITEM",
      note: "one latte",
      expectedReservedMinorUnits: 400,
    });
  });
});

describe("who may refund, and when", () => {
  it("a Refund Manager on a completed card order may refund what is left", () => {
    expect(refundAccess(response(), true)).toEqual({
      canIssue: true,
      reason: null,
      maxMinorUnits: 2000,
    });
  });
  it("mixed tender: only the card-paid amount (server figures), never the order total", () => {
    const mixed = response({
      balances: balances({ chargedMinorUnits: 1200, refundableMinorUnits: 1200 }),
    });
    expect(refundAccess(mixed, true).maxMinorUnits).toBe(1200);
  });
  it("orders.view without orders.refund: no action at all, no reason shown", () => {
    expect(refundAccess(response(), false)).toEqual({
      canIssue: false,
      reason: null,
      maxMinorUnits: 0,
    });
  });
  it("feature disabled: never an enabled action", () => {
    const a = refundAccess(response({ refundsEnabled: false }), true);
    expect(a.canIssue).toBe(false);
    expect(a.reason).toMatch(/switched on/);
  });
  it("blocks while a refund is unverified, or a returned refund is unreviewed", () => {
    expect(refundAccess(response({ balances: balances({ unresolved: true }) }), true).canIssue).toBe(false);
    const late = refundAccess(response({ balances: balances({ lateFailureNeedsReview: true }) }), true);
    expect(late.canIssue).toBe(false);
    expect(late.reason).toMatch(/Review it/);
  });
  it("a closed order refunds at most what is still owed; nothing when nothing is owed", () => {
    const owed = response({
      orderStatus: "CANCELLED",
      obligation: obligation({ outstandingMinorUnits: 800 }),
    });
    expect(refundAccess(owed, true).maxMinorUnits).toBe(800);
    expect(refundAccess(response({ orderStatus: "REJECTED" }), true).canIssue).toBe(false);
  });
  it("pauses new refunds while reconciliation flags are open; not for other currencies", () => {
    expect(refundAccess(response({ paymentNeedsAttention: true }), true).canIssue).toBe(false);
    expect(refundAccess(response({ attentionRefundIds: ["r1"] }), true).reason).toMatch(
      /need attention from support/,
    );
    expect(refundAccess(response({ currency: "JPY" }), true).canIssue).toBe(false);
    // "Owed again" (obligation needs attention) still allows a refund.
    expect(
      refundAccess(
        response({
          orderStatus: "CANCELLED",
          obligation: obligation({ needsAttention: true, outstandingMinorUnits: 500 }),
        }),
        true,
      ).canIssue,
    ).toBe(true);
  });

  it("in-progress orders and non-card orders cannot be refunded here", () => {
    expect(refundAccess(response({ orderStatus: "PREPARING" }), true).canIssue).toBe(false);
    expect(refundAccess(response({ balances: null }), true).canIssue).toBe(false);
    expect(
      refundAccess(response({ balances: balances({ refundableMinorUnits: 0 }) }), true).canIssue,
    ).toBe(false);
  });
});

describe("submitting, and recovering an unknown answer", () => {
  it("posts the request unchanged", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { refund: refund(), replayed: false, balances: balances(), obligation: null }),
    );
    const r = request({ note: "n" });
    const result = await requestOrderRefundFromBrowser(ORDER, r);
    expect(result.outcome).toBe("success");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/internal/admin/orders/${ORDER}/refunds`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(r);
  });

  it("a lost response is uncertain: the same request (same id) is kept, nothing new", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    const r = request();
    const lost = await requestOrderRefundFromBrowser(ORDER, r);
    expect(lost.outcome).toBe("uncertain");
    const next = flowAfter(r, lost);
    expect(next).toMatchObject({ flow: { step: "uncertain", request: r }, settled: false });
    // Checking the result resends the identical body: the server replays.
    fetchMock.mockResolvedValueOnce(
      reply(200, { refund: refund({ amountMinorUnits: 2000 }), replayed: true, balances: balances(), obligation: null }),
    );
    const again = await requestOrderRefundFromBrowser(ORDER, (next.flow as { request: CreateOrderRefundRequest }).request);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)),
    );
    const done = flowAfter(r, again);
    expect(done.flow.step).toBe("done");
    expect(done.settled).toBe(true);
    if (done.flow.step === "done") {
      expect(refundOutcomeMessage(done.flow.refund, done.flow.replayed)).toMatch(/already been submitted/);
    }
  });

  it.each([
    [500, undefined, undefined],
    [502, undefined, undefined],
    [429, undefined, undefined],
    [200, undefined, "garbage"],
    [200, { unexpected: true }, undefined],
  ])("status %s is uncertain, never a failure to retry as new", async (status, body, raw) => {
    fetchMock.mockResolvedValue(reply(status, body, raw));
    expect((await requestOrderRefundFromBrowser(ORDER, request())).outcome).toBe("uncertain");
  });

  it("a stale balance (409): explained, figures reloaded, and a fresh review required", async () => {
    fetchMock.mockResolvedValue(
      reply(409, { message: "The refunds of this order changed since you looked." }),
    );
    const r = request();
    const result = await requestOrderRefundFromBrowser(ORDER, r);
    const next = flowAfter(r, result);
    expect(next.reload).toBe(true);
    expect(next.settled).toBe(true);
    expect(next.flow.step).toBe("editing"); // back to the form: no request kept
    expect(next.flow.step === "editing" && next.flow.notice).toMatch(
      /changed since you looked.*review the refund again/,
    );
  });

  it("a refused retry of an unanswered refund keeps it pending (nothing proven)", () => {
    const r = request();
    for (const result of [
      { outcome: "forbidden" },
      { outcome: "unavailable" },
      { outcome: "invalid", message: "Bad." },
    ] as RefundActionResult[]) {
      const next = flowAfter(r, result, true);
      expect(next.settled).toBe(false);
      expect(next.flow).toMatchObject({ step: "uncertain", request: r });
    }
    // Success or a 409 settles it.
    expect(flowAfter(r, { outcome: "conflict", message: "Changed." }, true).settled).toBe(true);
  });

  it("forbidden and disabled close the form", () => {
    const r = request();
    const forbidden: RefundActionResult = { outcome: "forbidden" };
    const off: RefundActionResult = { outcome: "unavailable" };
    expect(flowAfter(r, forbidden).flow).toMatchObject({ step: "closed" });
    expect(flowAfter(r, off).flow).toMatchObject({ step: "closed" });
  });

  it("an unanswered request survives a reload (and only for this order and location)", () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const r = request({ note: "kept" });
    savePendingRefund(store, "user-a", ORDER, r);
    expect(loadPendingRefund(store, "user-a", ORDER, LOC)).toEqual(r);
    // Never another staff member's, another location's or another order's.
    expect(loadPendingRefund(store, "user-b", ORDER, LOC)).toBeNull();
    expect(loadPendingRefund(store, "user-a", ORDER, "another-location")).toBeNull();
    expect(loadPendingRefund(store, "user-a", "another-order", LOC)).toBeNull();
    data.set(`centerivo:pending-refund:user-a:${ORDER}`, "{not json");
    expect(loadPendingRefund(store, "user-a", ORDER, LOC)).toBeNull();
    savePendingRefund(store, "user-a", ORDER, r);
    clearPendingRefund(store, "user-a", ORDER);
    expect(loadPendingRefund(store, "user-a", ORDER, LOC)).toBeNull();
    // Storage that throws never breaks the page.
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => savePendingRefund(broken, "user-a", ORDER, r)).not.toThrow();
    expect(loadPendingRefund(broken, "user-a", ORDER, LOC)).toBeNull();
  });
});

describe("plain-language statuses", () => {
  it.each<[Partial<OrderRefundView>, string]>([
    [{ status: "PENDING" }, "Refund pending"],
    [{ status: "SUCCEEDED" }, "Refund successful"],
    [{ status: "FAILED" }, "Refund failed"],
    [{ status: "CANCELED" }, "Refund failed"],
    [{ status: "UNKNOWN" }, "Outcome being verified"],
    [{ status: "REQUESTED" }, "Outcome being verified"],
    [{ status: "SUCCEEDED", origin: "EXTERNAL" }, "Refunded through Stripe Dashboard"],
    [{ status: "PENDING", origin: "EXTERNAL" }, "Refund pending (Stripe Dashboard)"],
    [{ status: "FAILED_AFTER_SUCCESS" }, "Refund returned — needs review"],
    [
      { status: "FAILED_AFTER_SUCCESS", lateFailureReviewedAt: "2026-11-02T00:00:00.000Z" },
      "Refund returned (reviewed)",
    ],
    [{ status: "NOT_CREATED" }, "Not sent"],
  ])("%j → %s", (over, label) => {
    expect(refundStatusView(refund(over)).label).toBe(label);
  });

  it("recheck only for our unanswered or pending refunds; review only an unreviewed return", () => {
    expect(canRecheck(refund({ status: "UNKNOWN" }))).toBe(true);
    expect(canRecheck(refund({ status: "PENDING" }))).toBe(true);
    expect(canRecheck(refund({ status: "SUCCEEDED" }))).toBe(false);
    expect(canRecheck(refund({ status: "PENDING", origin: "EXTERNAL" }))).toBe(false);
    expect(needsLateFailureReview(refund({ status: "FAILED_AFTER_SUCCESS" }))).toBe(true);
    expect(
      needsLateFailureReview(
        refund({ status: "FAILED_AFTER_SUCCESS", lateFailureReviewedAt: "2026-11-02T00:00:00.000Z" }),
      ),
    ).toBe(false);
  });

  it("the mandatory review note", () => {
    expect(validateReviewNote("  ")).toBeTruthy();
    expect(validateReviewNote("x".repeat(501))).toBeTruthy();
    expect(validateReviewNote("Checked with the customer")).toBeNull();
  });

  it("a closed order is never called complete", () => {
    expect(closedOrderLine("COMPLETED")).toBe("This order is complete.");
    expect(closedOrderLine("REJECTED")).toBe("This order was rejected.");
    expect(closedOrderLine("CANCELLED")).toBe("This order was cancelled.");
    expect(closedOrderLine("READY")).toBeNull();
  });
});

describe("reads", () => {
  it("refunds are read for the order at the location, never cached", async () => {
    fetchMock.mockResolvedValue(reply(200, response()));
    const r = await getOrderRefundsFromBrowser(ORDER, LOC);
    expect(r.outcome).toBe("success");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/internal/admin/orders/${ORDER}/refunds?locationId=${LOC}`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store" });
  });
  it("wrong location / tenant (403 / 404) and unreadable replies are not data", async () => {
    fetchMock.mockResolvedValueOnce(reply(403));
    expect((await getOrderRefundsFromBrowser(ORDER, LOC)).outcome).toBe("forbidden");
    fetchMock.mockResolvedValueOnce(reply(404));
    expect((await getOrderRefundsFromBrowser(ORDER, LOC)).outcome).toBe("not-found");
    fetchMock.mockResolvedValueOnce(reply(200, { message: "oops" }));
    expect((await getOrderRefundsFromBrowser(ORDER, LOC)).outcome).toBe("error");
  });
  it("protected notes: whatever the API withheld stays withheld (nothing is filled in)", async () => {
    const viewOnly = response({
      refunds: [refund({ note: null, lateFailureReviewNote: null })],
    });
    fetchMock.mockResolvedValue(reply(200, viewOnly));
    const r = await getOrderRefundsFromBrowser(ORDER, LOC);
    expect(r.outcome === "success" && r.data.refunds[0].note).toBeNull();
  });
  it("refund obligations: owed list, needs-attention first, linkable by order", async () => {
    const item = (n: string, out: number, attention = false): OrderRefundObligationListItem => ({
      orderId: `id-${n}`,
      orderNumber: n,
      orderStatus: "CANCELLED",
      currency: "USD",
      obligation: obligation({ outstandingMinorUnits: out, needsAttention: attention }),
    });
    fetchMock.mockResolvedValue(
      reply(200, { obligations: [item("A1", 500), item("A2", 900), item("A3", 100, true)] }),
    );
    const r = await getRefundObligationsFromBrowser(LOC);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/internal/admin/orders/refund-obligations?locationId=${LOC}`,
    );
    expect(r.outcome).toBe("success");
    if (r.outcome === "success") {
      expect(obligationsOwedFirst(r.data.obligations).map((i) => i.orderNumber)).toEqual([
        "A3",
        "A2",
        "A1",
      ]);
    }
    expect(obligationStatusLabel(obligation())).toBe("Refund owed");
    expect(obligationStatusLabel(obligation({ inProgressMinorUnits: 100 }))).toBe(
      "Refund in progress",
    );
    expect(obligationStatusLabel(obligation({ refundedMinorUnits: 300 }))).toBe("Partly refunded");
    expect(
      obligationStatusLabel(obligation({ fullyRefunded: true, outstandingMinorUnits: 0 })),
    ).toBe("Refunded");
  });
});

describe("the web proxy's request marker", () => {
  it("every refund action carries it; reads do not need it", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { refund: refund(), replayed: false, balances: balances(), obligation: null }),
    );
    await requestOrderRefundFromBrowser(ORDER, request());
    await recheckOrderRefundFromBrowser(ORDER, "r1", LOC);
    await reviewOrderRefundFromBrowser(ORDER, "r1", LOC, "Checked");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-centerivo-request")).toBe("1");
    }
    fetchMock.mockResolvedValue(reply(200, response()));
    await getOrderRefundsFromBrowser(ORDER, LOC);
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual({ cache: "no-store" });
  });
});

describe("recheck and review", () => {
  it("recheck and review post only the location (and the note)", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { refund: refund(), replayed: false, balances: balances(), obligation: null }),
    );
    await recheckOrderRefundFromBrowser(ORDER, "r1", LOC);
    await reviewOrderRefundFromBrowser(ORDER, "r1", LOC, "Checked");
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/internal/admin/orders/${ORDER}/refunds/r1/recheck`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ locationId: LOC });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/internal/admin/orders/${ORDER}/refunds/r1/review`);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      locationId: LOC,
      note: "Checked",
    });
  });
  it("an unauthorized staff member's action is refused by the API (403 → forbidden)", async () => {
    fetchMock.mockResolvedValue(reply(403));
    expect((await recheckOrderRefundFromBrowser(ORDER, "r1", LOC)).outcome).toBe("forbidden");
    expect((await requestOrderRefundFromBrowser(ORDER, request())).outcome).toBe("forbidden");
  });
});
