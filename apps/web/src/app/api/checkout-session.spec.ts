import { NextRequest } from "next/server";

// ESP-03 PR 6 — the web checkout's server-owned session. The token is kept in
// an HttpOnly, host-only, SameSite=Strict cookie by this app's server and is
// never handed to browser code; the API decides whether a presented session
// is still this business's, location's and customer's.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/auth/session", () => ({
  CUSTOMER_SESSION_COOKIE: "mh_customer_session",
}));

import * as sessionRoute from "./checkout/session/route";
import {
  CHECKOUT_SESSION_COOKIE,
  MAX_CHECKOUT_SESSIONS,
  checkoutSessionCookieOptions,
  parseCheckoutSessions,
  serializeCheckoutSessions,
  tokenForLocation,
  withCheckoutSession,
  withoutCheckoutSession,
} from "@/lib/security/checkout-session";

const ORIGIN = "http://shop.test";
const TOKEN_A = `cs_${"A".repeat(43)}`;
const TOKEN_B = `cs_${"B".repeat(43)}`;
const fetchMock = jest.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const sameOrigin = {
  "x-centerivo-request": "1",
  "sec-fetch-site": "same-origin",
  origin: ORIGIN,
};
function post(body: unknown, headers: Record<string, string> = sameOrigin) {
  return sessionRoute.POST(
    new NextRequest(`${ORIGIN}/api/checkout/session`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.CSRF_ALLOWED_ORIGINS;
  delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("checkout-session cookie", () => {
  it("keeps one well-formed token per location, most recent first, bounded, and ignores tampering", () => {
    let sessions = withCheckoutSession([], "loc-1", TOKEN_A);
    sessions = withCheckoutSession(sessions, "loc-2", TOKEN_B);
    sessions = withCheckoutSession(sessions, "loc-1", TOKEN_B);
    expect(sessions).toEqual([
      ["loc-1", TOKEN_B],
      ["loc-2", TOKEN_B],
    ]);
    expect(parseCheckoutSessions(serializeCheckoutSessions(sessions))).toEqual(sessions);
    expect(tokenForLocation(sessions, "loc-3")).toBeNull();
    expect(withoutCheckoutSession(sessions, "loc-1")).toEqual([["loc-2", TOKEN_B]]);
    let many: ReturnType<typeof withCheckoutSession> = [];
    for (let i = 0; i < 9; i++) many = withCheckoutSession(many, `loc-${i}`, TOKEN_A);
    expect(many).toHaveLength(MAX_CHECKOUT_SESSIONS);
    for (const raw of ["not base64", Buffer.from('[["loc", "not-a-token"]]').toString("base64url"), Buffer.from('{"a":1}').toString("base64url")]) {
      expect(parseCheckoutSessions(raw)).toEqual([]);
    }
  });

  it("is HttpOnly, SameSite=Strict, host-only and Secure in production", () => {
    expect(checkoutSessionCookieOptions(60, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 60,
    });
    expect(checkoutSessionCookieOptions(60, { NODE_ENV: "development" } as NodeJS.ProcessEnv).secure).toBe(false);
  });
});

describe("POST /api/checkout/session", () => {
  it("starts a session: the token goes into the HttpOnly cookie, never into the browser's response", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        checkoutToken: TOKEN_A,
        state: "OPEN",
        acceptsNewPaymentsUntil: "2026-10-20T00:00:00.000Z",
        confirmation: null,
      }),
    );
    const res = await post({ locationId: "loc-1" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TOKEN_A);
    expect(JSON.parse(body)).toEqual({
      state: "OPEN",
      acceptsNewPaymentsUntil: "2026-10-20T00:00:00.000Z",
      orderId: null,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CHECKOUT_SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ locationId: "loc-1", checkoutToken: null });
  });

  it("resumes with the token from the cookie, and forwards the customer session when present", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { checkoutToken: TOKEN_A, state: "IN_PROGRESS", acceptsNewPaymentsUntil: "x", confirmation: null }),
    );
    const cookie = `mh_customer_session=ctok; ${CHECKOUT_SESSION_COOKIE}=${serializeCheckoutSessions([["loc-1", TOKEN_A]])}`;
    const res = await post({ locationId: "loc-1" }, { ...sameOrigin, cookie });
    expect(await res.json()).toMatchObject({ state: "IN_PROGRESS", orderId: null });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ locationId: "loc-1", checkoutToken: TOKEN_A });
    expect(init.headers.Authorization).toBe("Bearer ctok");
  });

  it("a completed checkout gives this browser its order (guest cookie), reports only the order id, and is then forgotten", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        checkoutToken: TOKEN_A,
        state: "COMPLETED",
        acceptsNewPaymentsUntil: "x",
        confirmation: { orderId: "order-1", accessToken: "a".repeat(32), guestName: "Private Guest" },
      }),
    );
    const cookie = `${CHECKOUT_SESSION_COOKIE}=${serializeCheckoutSessions([["loc-1", TOKEN_A]])}`;
    const res = await post({ locationId: "loc-1" }, { ...sameOrigin, cookie });
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ state: "COMPLETED", acceptsNewPaymentsUntil: "x", orderId: "order-1" });
    expect(body).not.toContain("a".repeat(32));
    expect(body).not.toContain("Private Guest");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`${CHECKOUT_SESSION_COOKIE}=;`));
    expect(setCookie).toContain("mh_guest_orders=");
  });

  it("refuses cross-site requests and a missing location without calling the API, and passes API refusals through", async () => {
    const crossSite = await post(
      { locationId: "loc-1" },
      { ...sameOrigin, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);
    expect((await post({})).status).toBe(400);
    expect((await post({ locationId: "../x" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json(404, { message: "Location or menu not found." }));
    const missing = await post({ locationId: "loc-9" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("set-cookie")).toBeNull();
  });

  it("a signed-in login that has not joined this restaurant gets a guest session; a restricted one never falls back", async () => {
    fetchMock
      .mockResolvedValueOnce(json(403, { code: "CUSTOMER_NOT_ENROLLED", businessName: "Bravo" }))
      .mockResolvedValueOnce(
        json(200, { checkoutToken: TOKEN_A, state: "OPEN", acceptsNewPaymentsUntil: "x", confirmation: null }),
      );
    const cookie = "mh_customer_session=ctok";
    const ok = await post({ locationId: "loc-1" }, { ...sameOrigin, cookie });
    expect(ok.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ctok");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(403, { code: "CUSTOMER_ACCOUNT_RESTRICTED", message: "Limited" }));
    const restricted = await post({ locationId: "loc-1" }, { ...sameOrigin, cookie });
    expect(restricted.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never stores a malformed token from the API", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { checkoutToken: "nope", state: "OPEN", confirmation: null }));
    const res = await post({ locationId: "loc-1" });
    expect(res.status).toBe(502);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
