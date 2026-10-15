import { NextRequest } from "next/server";

jest.mock("@/lib/auth/session", () => ({
  CUSTOMER_SESSION_COOKIE: "mh_customer_session",
}));

import * as statusRoute from "./[orderId]/status/route";
import * as sessionRoute from "./[orderId]/guest-session/route";
import * as shareRoute from "./[orderId]/share-link/route";
import * as checkoutRoute from "../checkout/route";
import {
  GUEST_SESSION_COOKIE,
  serializeGuestSession,
} from "@/lib/security/guest-session";

const ORIGIN = "http://shop.test";
const ORDER_A = "ordA1234";
const ORDER_B = "ordB5678";
const TOKEN_A = "tokenAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "tokenBBBBBBBBBBBBBBBBBBBB";
const fetchMock = jest.fn();

const sameOrigin = {
  "x-centerivo-request": "1",
  "sec-fetch-site": "same-origin",
  origin: ORIGIN,
};
const jar = (orders: Array<[string, string]>) =>
  `${GUEST_SESSION_COOKIE}=${serializeGuestSession(orders)}`;
const ctx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const req = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
) => new NextRequest(`${ORIGIN}${url}`, { method, headers, body });

const apiOk = (body: unknown = { orderId: ORDER_A, status: "PREPARING", lines: [] }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.CLIENT_IP_FORWARD_SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => apiOk());
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("GET /api/orders/:id/status", () => {
  it("polls with the cookie's token in a header, never in the URL", async () => {
    const res = await statusRoute.GET(
      req("GET", `/api/orders/${ORDER_A}/status`, {
        cookie: jar([[ORDER_A, TOKEN_A]]),
      }),
      ctx(ORDER_A),
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://api.test/api/v1/orders/${ORDER_A}`);
    expect(url).not.toContain(TOKEN_A);
    expect(init.headers["x-order-access-token"]).toBe(TOKEN_A);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers an identical 404 for no cookie, no entry for this order, and tampered cookies — without calling the API", async () => {
    const cookies = [
      "",
      jar([[ORDER_B, TOKEN_B]]), // a session for ANOTHER order
      `${GUEST_SESSION_COOKIE}=not-base64-json`,
      `${GUEST_SESSION_COOKIE}=${Buffer.from("[[1,2]]").toString("base64url")}`,
      `${GUEST_SESSION_COOKIE}=${Buffer.from('{"a":"b"}').toString("base64url")}`,
    ];
    const bodies = new Set<string>();
    for (const cookie of cookies) {
      const res = await statusRoute.GET(
        req("GET", `/api/orders/${ORDER_A}/status`, cookie ? { cookie } : {}),
        ctx(ORDER_A),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lets one order's token reach another order's request", async () => {
    await statusRoute.GET(
      req("GET", `/api/orders/${ORDER_B}/status`, {
        cookie: jar([
          [ORDER_A, TOKEN_A],
          [ORDER_B, TOKEN_B],
        ]),
      }),
      ctx(ORDER_B),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://api.test/api/v1/orders/${ORDER_B}`);
    expect(init.headers["x-order-access-token"]).toBe(TOKEN_B);
  });

  it("refuses an order id that is not a plain identifier (no path games)", async () => {
    for (const id of ["../x", "a/b", "a%2fb", "x".repeat(100)]) {
      const res = await statusRoute.GET(
        req("GET", "/api/orders/x/status", { cookie: jar([[ORDER_A, TOKEN_A]]) }),
        ctx(id),
      );
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream outcomes: 404 -> the same 404, 429 -> 429 + Retry-After, 5xx -> 502", async () => {
    const cookie = { cookie: jar([[ORDER_A, TOKEN_A]]) };
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const notFound = await statusRoute.GET(req("GET", "/x", cookie), ctx(ORDER_A));
    expect(notFound.status).toBe(404);

    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
    );
    const limited = await statusRoute.GET(req("GET", "/x", cookie), ctx(ORDER_A));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect((await statusRoute.GET(req("GET", "/x", cookie), ctx(ORDER_A))).status).toBe(502);

    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect((await statusRoute.GET(req("GET", "/x", cookie), ctx(ORDER_A))).status).toBe(503);
  });
});

describe("POST /api/orders/:id/guest-session (bootstrap)", () => {
  const post = (headers: Record<string, string>, body: unknown) =>
    sessionRoute.POST(
      req("POST", `/api/orders/${ORDER_A}/guest-session`, headers, JSON.stringify(body)),
      ctx(ORDER_A),
    );

  it("verifies the token with the API, then sets an HttpOnly Lax cookie; the token is not echoed", async () => {
    const res = await post(sameOrigin, { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers["x-order-access-token"]).toBe(TOKEN_A);
    expect(fetchMock.mock.calls[0][0]).not.toContain(TOKEN_A);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${GUEST_SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/Max-Age=\d+/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(await res.text()).not.toContain(TOKEN_A);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps earlier orders in the same browser when adding another", async () => {
    const res = await post({ ...sameOrigin, cookie: jar([[ORDER_B, TOKEN_B]]) }, { token: TOKEN_A });
    const value = decodeURIComponent(
      (res.headers.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="),
    );
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    expect(decoded).toEqual([
      [ORDER_A, TOKEN_A],
      [ORDER_B, TOKEN_B],
    ]);
  });

  it("sets nothing for a wrong token or unknown order (same 404 either way)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const res = await post(sameOrigin, { token: TOKEN_A });
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects malformed tokens/bodies without calling the API", async () => {
    for (const body of [{}, { token: "short" }, { token: 7 }, { token: "a b c d e f g h i j k l m n o p" }, null]) {
      const res = await post(sameOrigin, body);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const bad = await sessionRoute.POST(
      req("POST", "/x", sameOrigin, "not json"),
      ctx(ORDER_A),
    );
    expect(bad.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is protected by the request-origin check (S3b): cross-site, same-site, no marker", async () => {
    for (const headers of [
      { ...sameOrigin, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { ...sameOrigin, "sec-fetch-site": "same-site", origin: "http://evil.shop.test" },
      { "sec-fetch-site": "same-origin", origin: ORIGIN },
    ]) {
      const res = await post(headers, { token: TOKEN_A });
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a rate-limit answer through without setting a cookie", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
    );
    const res = await post(sameOrigin, { token: TOKEN_A });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/orders/:id/share-link", () => {
  const post = (headers: Record<string, string>, id = ORDER_A) =>
    shareRoute.POST(req("POST", `/api/orders/${id}/share-link`, headers), ctx(id));

  it("hands back only this order's token, uncached, on an explicit same-origin request", async () => {
    const res = await post({
      ...sameOrigin,
      cookie: jar([
        [ORDER_B, TOKEN_B],
        [ORDER_A, TOKEN_A],
      ]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: TOKEN_A });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s without a session for that order; 403s cross-site", async () => {
    expect((await post({ ...sameOrigin, cookie: jar([[ORDER_B, TOKEN_B]]) })).status).toBe(404);
    expect((await post(sameOrigin)).status).toBe(404);
    expect(
      (
        await post({
          ...sameOrigin,
          "sec-fetch-site": "cross-site",
          cookie: jar([[ORDER_A, TOKEN_A]]),
        })
      ).status,
    ).toBe(403);
  });
});

describe("POST /api/checkout starts the guest session", () => {
  const confirmation = {
    orderId: ORDER_A,
    orderNumber: "AB12CD",
    accessToken: TOKEN_A,
  };
  const checkout = () =>
    checkoutRoute.POST(req("POST", "/api/checkout", sameOrigin, "{}"));

  it("sets the cookie and leaves the response body unchanged for existing clients", async () => {
    fetchMock.mockResolvedValue(apiOk(confirmation));
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(confirmation);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${GUEST_SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
  });

  it("sets no cookie when the order was not placed, or the body is not a confirmation", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 402 }));
    expect((await checkout()).headers.get("set-cookie")).toBeNull();
    fetchMock.mockResolvedValueOnce(apiOk({ orderId: ORDER_A }));
    expect((await checkout()).headers.get("set-cookie")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect((await checkout()).headers.get("set-cookie")).toBeNull();
  });
});
