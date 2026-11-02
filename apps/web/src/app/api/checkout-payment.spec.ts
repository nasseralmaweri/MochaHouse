import { NextRequest } from "next/server";

// ESP-04 M2 — the two-step payment through this app's server: the browser
// sends only a location (and, for the development simulator, an outcome);
// the checkout-session token comes from the HttpOnly cookie. A 202 (payment
// waiting) keeps the checkout so a reload resumes the same payment; only a
// placed order (200 / 201) ends it here.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/auth/session", () => ({
  CUSTOMER_SESSION_COOKIE: "mh_customer_session",
}));

import * as checkoutRoute from "./checkout/route";
import * as paymentRoute from "./checkout/payment/route";
import * as simulateRoute from "./checkout/payment/simulate/route";
import {
  CHECKOUT_SESSION_COOKIE,
  serializeCheckoutSessions,
  withCheckoutSession,
} from "@/lib/security/checkout-session";

const ORIGIN = "http://shop.test";
const TOKEN_A = `cs_${"A".repeat(43)}`;
const fetchMock = jest.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const cookie = `${CHECKOUT_SESSION_COOKIE}=${serializeCheckoutSessions(
  withCheckoutSession([], "loc-1", TOKEN_A),
)}`;
const sameOrigin = {
  "x-centerivo-request": "1",
  "sec-fetch-site": "same-origin",
  origin: ORIGIN,
  cookie,
};
function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = sameOrigin,
) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
const WAITING = {
  outcome: "PAYMENT_REQUIRED",
  payment: {
    provider: "fake-two-step",
    state: "REQUIRES_CUSTOMER_ACTION",
    clientSecret: null,
    amountMinorUnits: 700,
    currency: "USD",
  },
};
const ORDER = {
  orderId: "11111111-1111-7111-8111-111111111111",
  accessToken: "x",
};
// The routes only ever (re)write the checkout cookie to forget a checkout.
const clearsCheckout = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").includes(`${CHECKOUT_SESSION_COOKIE}=`);

const originalEnv = process.env.NODE_ENV;
beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.CSRF_ALLOWED_ORIGINS;
  delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
});

describe("POST /api/checkout — two-step payments", () => {
  it("passes a 202 through and KEEPS this checkout's session cookie", async () => {
    fetchMock.mockResolvedValueOnce(json(202, WAITING));
    const res = await checkoutRoute.POST(
      request("/api/checkout", {
        locationId: "loc-1",
        guest: { name: "A", phone: "5551234567" },
        lines: [],
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(WAITING);
    expect(clearsCheckout(res)).toBe(false);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("mh_guest");
  });

  it("still ends the checkout on a placed order (201)", async () => {
    fetchMock.mockResolvedValueOnce(json(201, ORDER));
    const res = await checkoutRoute.POST(
      request("/api/checkout", {
        locationId: "loc-1",
        guest: { name: "A", phone: "5551234567" },
        lines: [],
      }),
    );
    expect(res.status).toBe(201);
    expect(clearsCheckout(res)).toBe(true);
  });
});

describe("POST /api/checkout/payment", () => {
  it("sends only the location and the cookie's token; a 202 keeps the checkout", async () => {
    fetchMock.mockResolvedValueOnce(json(202, WAITING));
    const res = await paymentRoute.POST(
      request("/api/checkout/payment", {
        locationId: "loc-1",
        amount: 1,
        checkoutToken: "cs_forged",
        succeeded: true,
      }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(clearsCheckout(res)).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v1/orders/checkout-sessions/payment");
    expect(JSON.parse(init.body as string)).toEqual({
      locationId: "loc-1",
      checkoutToken: TOKEN_A,
    });
  });

  it("a paid checkout (200) ends the checkout here", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ORDER));
    const res = await paymentRoute.POST(
      request("/api/checkout/payment", { locationId: "loc-1" }),
    );
    expect(res.status).toBe(200);
    expect(clearsCheckout(res)).toBe(true);
  });

  it("passes 402 and 409 through and keeps the checkout", async () => {
    for (const status of [402, 409]) {
      fetchMock.mockResolvedValueOnce(json(status, { message: "x" }));
      const res = await paymentRoute.POST(
        request("/api/checkout/payment", { locationId: "loc-1" }),
      );
      expect(res.status).toBe(status);
      expect(clearsCheckout(res)).toBe(false);
    }
  });

  it("refuses a cross-site request and one without a checkout session, without calling the API", async () => {
    const crossSite = await paymentRoute.POST(
      request(
        "/api/checkout/payment",
        { locationId: "loc-1" },
        { origin: "http://evil.test", "sec-fetch-site": "cross-site", cookie },
      ),
    );
    expect(crossSite.status).toBe(403);
    const noSession = await paymentRoute.POST(
      request("/api/checkout/payment", { locationId: "loc-2" }),
    );
    expect(noSession.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when the API cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const res = await paymentRoute.POST(
      request("/api/checkout/payment", { locationId: "loc-1" }),
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /api/checkout/payment/simulate (development only)", () => {
  it("forwards only the location, the cookie's token and a known outcome", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await simulateRoute.POST(
      request("/api/checkout/payment/simulate", {
        locationId: "loc-1",
        outcome: "succeed",
        amount: 1,
      }),
    );
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://api.test/api/v1/orders/checkout-sessions/payment/simulate",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      locationId: "loc-1",
      checkoutToken: TOKEN_A,
      outcome: "succeed",
    });
  });

  it("refuses an unknown outcome and a cross-site request", async () => {
    const bad = await simulateRoute.POST(
      request("/api/checkout/payment/simulate", {
        locationId: "loc-1",
        outcome: "refund",
      }),
    );
    expect(bad.status).toBe(400);
    const crossSite = await simulateRoute.POST(
      request(
        "/api/checkout/payment/simulate",
        { locationId: "loc-1", outcome: "succeed" },
        { origin: "http://evil.test", "sec-fetch-site": "cross-site", cookie },
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not exist in a production-like deployment (the API's classifier)", async () => {
    for (const [name, value] of [
      ["APP_ENV", "staging"],
      ["DEPLOYMENT_ENV", "live"],
      ["CENTERIVO_ENV", " Production "],
    ]) {
      process.env[name] = value;
      try {
        const res = await simulateRoute.POST(
          request("/api/checkout/payment/simulate", {
            locationId: "loc-1",
            outcome: "succeed",
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        delete process.env[name];
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not exist in a production build", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const res = await simulateRoute.POST(
      request("/api/checkout/payment/simulate", {
        locationId: "loc-1",
        outcome: "succeed",
      }),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
