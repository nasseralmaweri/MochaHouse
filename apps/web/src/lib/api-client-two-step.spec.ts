import {
  checkCheckoutPaymentFromBrowser,
  simulateCheckoutPaymentFromBrowser,
  submitCheckoutFromBrowser,
} from "./api-client";

// ESP-04 M2 — how the checkout page reads two-step payment answers: a 202 is
// a payment waiting for the customer (never a success), a malformed 202 is
// never treated as paid, and the browser sends only a location (and, to the
// development simulator, an outcome) — never an amount or a payment.
describe("two-step checkout client", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const respond = (status: number, body: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  const payment = {
    provider: "fake-two-step",
    state: "REQUIRES_PAYMENT_METHOD",
    clientSecret: null,
    amountMinorUnits: 700,
    currency: "USD",
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("maps a 202 to payment-required with the payment details", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(202, { outcome: "PAYMENT_REQUIRED", payment }),
    );
    const result = await submitCheckoutFromBrowser({
      locationId: "loc-1",
      guest: { name: "A", phone: "5551234567" },
      lines: [],
    });
    expect(result).toEqual({ outcome: "payment-required", payment });
  });

  it("never reads a malformed 202 as paid", async () => {
    fetchMock.mockResolvedValueOnce(respond(202, { outcome: "COMPLETED" }));
    const result = await checkCheckoutPaymentFromBrowser("loc-1");
    expect(result.outcome).toBe("network-error");
  });

  it("checks with the location only, and maps 200, 402 and 409", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { orderId: "o1" }))
      .mockResolvedValueOnce(respond(402, { outcome: "failed", message: "no" }))
      .mockResolvedValueOnce(respond(409, { message: "wait" }));
    expect((await checkCheckoutPaymentFromBrowser("loc-1")).outcome).toBe(
      "success",
    );
    expect((await checkCheckoutPaymentFromBrowser("loc-1")).outcome).toBe(
      "failed",
    );
    expect((await checkCheckoutPaymentFromBrowser("loc-1")).outcome).toBe(
      "conflict",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/checkout/payment");
    expect(JSON.parse(init.body as string)).toEqual({ locationId: "loc-1" });
  });

  it("a lost check is a network error that says the payment was not affected", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result = await checkCheckoutPaymentFromBrowser("loc-1");
    expect(result).toMatchObject({ outcome: "network-error" });
  });

  it("the simulator sends only the location and the outcome", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(204, undefined))
      .mockResolvedValueOnce(
        respond(404, { code: "PAYMENT_SIMULATION_NOT_AVAILABLE" }),
      );
    expect(await simulateCheckoutPaymentFromBrowser("loc-1", "succeed")).toBe(
      true,
    );
    expect(await simulateCheckoutPaymentFromBrowser("loc-1", "succeed")).toBe(
      false,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/checkout/payment/simulate");
    expect(JSON.parse(init.body as string)).toEqual({
      locationId: "loc-1",
      outcome: "succeed",
    });
  });
});
