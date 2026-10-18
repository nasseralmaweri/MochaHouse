// SC4f-2 — the web side of one CENTERIVO login with a profile per
// restaurant: where a signed-in visitor stands at this restaurant, the
// explicit join call, and the post-join return path.

const cookieJar = new Map<string, string>();
jest.mock("server-only", () => ({}));
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
  }),
  headers: async () => new Headers(),
}));
const redirectMock = jest.fn((path: string) => {
  throw new Error(`REDIRECT ${path}`);
});
jest.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import {
  CUSTOMER_SESSION_COOKIE,
  getCustomerAccountState,
  getCustomerSession,
} from "./session";
import { enrollCustomer, safeReturnPath } from "./enrollment";

const fetchMock = jest.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const PROFILE = {
  id: "c1",
  email: "a@example.com",
  displayName: "A",
  status: "ACTIVE",
  emailVerified: true,
  createdAt: "2026-10-17T00:00:00.000Z",
};

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
  cookieJar.clear();
  fetchMock.mockReset();
  redirectMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("getCustomerAccountState", () => {
  it("is signed-out without a session, and never calls the API", async () => {
    expect(await getCustomerAccountState()).toEqual({ kind: "signed-out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns this restaurant's profile, whatever its status", async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, "tok");
    for (const status of ["ACTIVE", "RESTRICTED", "DEACTIVATED"]) {
      fetchMock.mockResolvedValueOnce(json(200, { ...PROFILE, status }));
      expect(await getCustomerAccountState()).toEqual({
        kind: "signed-in",
        profile: { ...PROFILE, status },
      });
    }
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://api.test/api/v1/customers/me",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("reports not-enrolled with the restaurant name the API resolved", async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, "tok");
    fetchMock.mockResolvedValueOnce(
      json(403, { code: "CUSTOMER_NOT_ENROLLED", businessName: "Bravo Cafe" }),
    );
    expect(await getCustomerAccountState()).toEqual({
      kind: "not-enrolled",
      businessName: "Bravo Cafe",
    });
  });

  it("treats any other refusal, an invalid token or an outage as signed-out", async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, "tok");
    fetchMock.mockResolvedValueOnce(json(403, { code: "SOMETHING_ELSE" }));
    fetchMock.mockResolvedValueOnce(json(401, {}));
    fetchMock.mockRejectedValueOnce(new TypeError("down"));
    for (let i = 0; i < 3; i++) {
      expect(await getCustomerAccountState()).toEqual({ kind: "signed-out" });
    }
  });
});

describe("getCustomerSession", () => {
  it("sends a login that has not joined this restaurant to /account/join", async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, "tok");
    fetchMock.mockResolvedValueOnce(
      json(403, { code: "CUSTOMER_NOT_ENROLLED", businessName: "Bravo Cafe" }),
    );
    await expect(getCustomerSession()).rejects.toThrow("REDIRECT /account/join");
  });

  it("returns the profile, or null when signed out", async () => {
    expect(await getCustomerSession()).toBeNull();
    cookieJar.set(CUSTOMER_SESSION_COOKIE, "tok");
    fetchMock.mockResolvedValueOnce(json(200, PROFILE));
    expect(await getCustomerSession()).toEqual(PROFILE);
  });
});

describe("enrollCustomer", () => {
  it("posts the explicit join with the session's token and nothing naming a restaurant", async () => {
    fetchMock.mockResolvedValueOnce(
      json(201, { created: true, profile: PROFILE }),
    );
    const result = await enrollCustomer("tok");
    expect(result).toEqual({
      outcome: "success",
      response: { created: true, profile: PROFILE },
    });
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("http://api.test/api/v1/customers/me/enrollment");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({});
  });

  it("maps refusals, rate limiting and outages", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        code: "CUSTOMER_EMAIL_NOT_VERIFIED",
        message: "Verify your email address before joining a restaurant.",
      }),
    );
    expect(await enrollCustomer("tok")).toEqual({
      outcome: "refused",
      message: "Verify your email address before joining a restaurant.",
    });
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await enrollCustomer("tok")).toEqual({ outcome: "unauthorized" });
    fetchMock.mockResolvedValueOnce(json(429, {}));
    expect(await enrollCustomer("tok")).toEqual({ outcome: "rate-limited" });
    fetchMock.mockRejectedValueOnce(new TypeError("down"));
    expect(await enrollCustomer("tok")).toEqual({ outcome: "error" });
  });
});

describe("safeReturnPath", () => {
  it("allows only this app's own account and ordering pages", () => {
    expect(safeReturnPath("/order/checkout")).toBe("/order/checkout");
    expect(safeReturnPath("/account")).toBe("/account");
    expect(safeReturnPath("/account/orders")).toBe("/account/orders");
    for (const bad of [
      undefined,
      null,
      "",
      "https://evil.example/account",
      "//evil.example/account",
      "/\\evil.example",
      "/admin",
      "/order/checkout?x=https://evil.example",
      "/account/../admin",
      "account",
    ]) {
      expect(safeReturnPath(bad)).toBe("/account");
    }
  });
});
