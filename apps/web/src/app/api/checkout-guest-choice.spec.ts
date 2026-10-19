import { NextRequest } from "next/server";

// SC4f-2 — "Continue as a guest" after the join prompt: honoured only for a
// signed-in login that has NOT joined this restaurant. A profile here —
// active, restricted or deactivated — never silently falls back to a guest
// order.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/auth/session", () => ({
  CUSTOMER_SESSION_COOKIE: "mh_customer_session",
}));

import * as checkoutRoute from "./checkout/route";
import { submitCheckoutFromBrowser } from "@/lib/api-client";
import { serializeCheckoutSessions } from "@/lib/security/checkout-session";

// ESP-03 PR 6 — the checkout-session token lives in the HttpOnly
// checkout cookie (never in the browser's request body).
const TOKEN = `cs_${"A".repeat(43)}`;
const CHECKOUT_COOKIE = `mh_checkout=${serializeCheckoutSessions([["loc-1", TOKEN]])}`;

const ORIGIN = "http://shop.test";
const fetchMock = jest.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.CSRF_ALLOWED_ORIGINS;
  delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function post(path: string, cookie: string | null) {
  return checkoutRoute.POST(
    new NextRequest(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "x-centerivo-request": "1",
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        cookie: cookie ? `${cookie}; ${CHECKOUT_COOKIE}` : CHECKOUT_COOKIE,
      },
      body: JSON.stringify({ locationId: "loc-1" }),
    }),
  );
}

describe("checkout route: guest choice", () => {
  it("places a guest order without the session once the API confirms the login has not joined", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(403, { code: "CUSTOMER_NOT_ENROLLED", businessName: "Bravo" }),
      )
      .mockResolvedValueOnce(json(201, { orderId: "o1" }));
    const res = await post("/api/checkout?as=guest", "mh_customer_session=ctok");
    expect(res.status).toBe(201);
    const [meTarget, meInit] = fetchMock.mock.calls[0];
    expect(meTarget).toBe("http://api.test/api/v1/customers/me");
    expect(meInit.headers.Authorization).toBe("Bearer ctok");
    const [orderTarget, orderInit] = fetchMock.mock.calls[1];
    expect(orderTarget).toBe("http://api.test/api/v1/orders");
    expect(orderInit.headers.Authorization).toBeUndefined();
  });

  it("refuses a guest order for a login with a profile here, whatever its status", async () => {
    const answers = [
      json(200, { id: "c1", status: "ACTIVE" }),
      json(200, { id: "c1", status: "RESTRICTED" }),
      json(200, { id: "c1", status: "DEACTIVATED" }),
      json(403, { code: "SOMETHING_ELSE" }),
    ];
    for (const answer of answers) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(answer);
      const res = await post(
        "/api/checkout?as=guest",
        "mh_customer_session=ctok",
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "GUEST_CHECKOUT_NOT_ALLOWED",
      });
      // Nothing was placed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("an expired sign-in must sign in again; an outage is reported as one — never a guest order", async () => {
    fetchMock.mockResolvedValueOnce(json(401, {}));
    const expired = await post("/api/checkout?as=guest", "mh_customer_session=ctok");
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ code: "SESSION_EXPIRED" });

    fetchMock.mockResolvedValueOnce(json(500, {}));
    const down = await post("/api/checkout?as=guest", "mh_customer_session=ctok");
    expect(down.status).toBe(503);

    fetchMock.mockRejectedValueOnce(new TypeError("unreachable"));
    const unreachable = await post("/api/checkout?as=guest", "mh_customer_session=ctok");
    expect(unreachable.status).toBe(503);
    // Only the account checks were made: nothing was placed.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [target] of fetchMock.mock.calls) {
      expect(target).toBe("http://api.test/api/v1/customers/me");
    }
  });

  it("is plain guest checkout for a signed-out visitor", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { orderId: "o1" }));
    const res = await post("/api/checkout?as=guest", null);
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("without the choice, a signed-in checkout still carries the session", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { orderId: "o1" }));
    await post("/api/checkout", "mh_customer_session=ctok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ctok");
  });

  it("ESP-03 PR 6: adds this location's checkout-session token from the cookie, and forgets it once the order is placed", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { orderId: "o1" }));
    const res = await post("/api/checkout", null);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ locationId: "loc-1", checkoutToken: TOKEN });
    expect(res.headers.get("set-cookie")).toMatch(/mh_checkout=;/);
  });

  it("ESP-03 PR 6: an out-of-date page that sends a payment key, or a checkout with no session, is refused before the API is called", async () => {
    const stale = await checkoutRoute.POST(
      new NextRequest(`${ORIGIN}/api/checkout`, {
        method: "POST",
        headers: {
          "x-centerivo-request": "1",
          "sec-fetch-site": "same-origin",
          origin: ORIGIN,
          cookie: CHECKOUT_COOKIE,
        },
        body: JSON.stringify({ locationId: "loc-1", idempotencyKey: "k" }),
      }),
    );
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "CLIENT_PAYMENT_KEY_NOT_ACCEPTED" });
    const noSession = await checkoutRoute.POST(
      new NextRequest(`${ORIGIN}/api/checkout`, {
        method: "POST",
        headers: {
          "x-centerivo-request": "1",
          "sec-fetch-site": "same-origin",
          origin: ORIGIN,
        },
        body: JSON.stringify({ locationId: "loc-2" }),
      }),
    );
    expect(noSession.status).toBe(409);
    expect(await noSession.json()).toMatchObject({ code: "CHECKOUT_SESSION_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("submitCheckoutFromBrowser: account outcomes", () => {
  const request = {} as Parameters<typeof submitCheckoutFromBrowser>[0];

  it("reports not-enrolled with the restaurant's name, and asks for guest only when chosen", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, { code: "CUSTOMER_NOT_ENROLLED", businessName: "Bravo Cafe" }),
    );
    expect(await submitCheckoutFromBrowser(request)).toEqual({
      outcome: "not-enrolled",
      businessName: "Bravo Cafe",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/checkout");

    fetchMock.mockResolvedValueOnce(json(201, { orderId: "o1" }));
    await submitCheckoutFromBrowser(request, { asGuest: true });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/checkout?as=guest");
  });

  it("reports an expired sign-in so the page can offer to sign in again", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: "SESSION_EXPIRED", message: "Sign in again." }));
    expect(await submitCheckoutFromBrowser(request, { asGuest: true })).toEqual({
      outcome: "session-expired",
      message: "Sign in again.",
    });
  });

  it("reports a limited account, never as something a guest order could fix", async () => {
    for (const code of [
      "CUSTOMER_ACCOUNT_RESTRICTED",
      "CUSTOMER_ACCOUNT_UNAVAILABLE",
    ]) {
      fetchMock.mockResolvedValueOnce(
        json(403, { code, message: "Your account at this restaurant is limited." }),
      );
      expect(await submitCheckoutFromBrowser(request)).toEqual({
        outcome: "account-limited",
        message: "Your account at this restaurant is limited.",
      });
    }
  });
});
