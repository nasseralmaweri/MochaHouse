import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// The route modules import server-only session helpers; stand them in.
jest.mock("@/lib/internal-auth/session", () => ({
  INTERNAL_SESSION_COOKIE: "mh_internal_session",
}));
jest.mock("@/lib/internal-auth/active-business", () => ({
  internalAuthHeaders: async (token: string) => ({
    Authorization: `Bearer ${token}`,
  }),
}));
jest.mock("@/lib/auth/session", () => ({
  CUSTOMER_SESSION_COOKIE: "mh_customer_session",
}));

import * as adminRoute from "./internal/admin/[...path]/route";
import * as mediaRoute from "./internal/admin/media/route";
import * as checkoutRoute from "./checkout/route";

const ORIGIN = "http://shop.test";
const fetchMock = jest.fn();

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.CSRF_ALLOWED_ORIGINS;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

const sameOrigin = {
  "x-centerivo-request": "1",
  "sec-fetch-site": "same-origin",
  origin: ORIGIN,
  cookie: "mh_internal_session=tok; mh_customer_session=ctok",
};

function req(
  method: string,
  url: string,
  headers: Record<string, string> = sameOrigin,
  body?: BodyInit,
): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, { method, headers, body });
}
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

describe("admin catch-all proxy", () => {
  it("forwards a same-origin mutation with the bearer token", async () => {
    const res = await adminRoute.POST(
      req("POST", "/api/internal/admin/orders/42/advance", sameOrigin, "{}"),
      ctx("orders", "42", "advance"),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("http://api.test/api/v1/admin/orders/42/advance");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("still serves reads (GET) without the marker header", async () => {
    const res = await adminRoute.GET(
      req("GET", "/api/internal/admin/orders?locationId=a", { cookie: sameOrigin.cookie }),
      ctx("orders"),
    );
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://api.test/api/v1/admin/orders?locationId=a",
    );
  });

  const blocked: Array<[string, Record<string, string>]> = [
    ["cross-site page", { ...sameOrigin, "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["same-site sibling", { ...sameOrigin, "sec-fetch-site": "same-site", origin: "http://evil.shop.test" }],
    ["forged Origin", { ...sameOrigin, "sec-fetch-site": "same-origin", origin: "https://evil.example" }],
    ["no marker header", { cookie: sameOrigin.cookie, "sec-fetch-site": "same-origin", origin: ORIGIN }],
    ["no browser headers", { cookie: sameOrigin.cookie, "x-centerivo-request": "1" }],
  ];
  it.each(blocked)("blocks a mutation from: %s", async (_name, headers) => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      const handler = adminRoute[method];
      const res = await handler(
        req(method, "/api/internal/admin/orders/42/advance", headers, method === "DELETE" ? undefined : "{}"),
        ctx("orders", "42", "advance"),
      );
      expect(res.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an allowed extra origin works when configured, not otherwise", async () => {
    const headers = { ...sameOrigin, origin: "https://front.example", "sec-fetch-site": "same-origin" };
    expect(
      (await adminRoute.POST(req("POST", "/api/internal/admin/x", headers, "{}"), ctx("x"))).status,
    ).toBe(403);
    process.env.CSRF_ALLOWED_ORIGINS = "https://front.example";
    expect(
      (await adminRoute.POST(req("POST", "/api/internal/admin/x", headers, "{}"), ctx("x"))).status,
    ).toBe(200);
  });

  describe("path traversal", () => {
    // What Next hands the handler as params for each request URL variant is
    // not guaranteed, so the decoded and encoded forms are both exercised.
    const traversals: string[][] = [
      ["..", "internal", "me"],
      ["orders", "..", "..", "internal", "me"],
      ["%2e%2e", "internal", "me"],
      ["%2E%2E", "internal", "me"],
      [".", "orders"],
      ["%252e%252e", "internal", "me"],
      ["..%2finternal%2fme"],
      ["%2e%2e%2finternal"],
      ["orders", "..\\..\\internal"],
    ];
    it.each(traversals)("never reaches the API for %j", async (...segments) => {
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const res = await adminRoute[method](
          req(method, "/api/internal/admin/x", sameOrigin, method === "POST" ? "{}" : undefined),
          ctx(...segments),
        );
        expect(res.status).toBe(404);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a traversal arriving in the request URL itself", async () => {
      // Whatever the framework does with these, nothing may reach /internal.
      for (const url of [
        "/api/internal/admin/%2e%2e/internal/me",
        "/api/internal/admin/%2E%2E%2Finternal%2Fme",
        "/api/internal/admin/orders/%252e%252e/%252e%252e/internal/me",
      ]) {
        const parsed = new URL(`${ORIGIN}${url}`);
        const segments = parsed.pathname
          .replace("/api/internal/admin/", "")
          .split("/");
        await adminRoute.GET(
          req("GET", url, { cookie: sameOrigin.cookie }),
          ctx(...segments),
        );
      }
      for (const call of fetchMock.mock.calls) {
        expect(new URL(call[0]).pathname.startsWith("/api/v1/admin/")).toBe(true);
        expect(new URL(call[0]).pathname).not.toMatch(/internal\/me/);
      }
    });
  });
});

describe("media upload proxy", () => {
  const multipart = { ...sameOrigin, "content-type": "multipart/form-data; boundary=x" };

  it("forwards a same-origin upload", async () => {
    const res = await mediaRoute.POST(
      req("POST", "/api/internal/admin/media", multipart, "--x--"),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-site and header-less uploads", async () => {
    for (const headers of [
      { ...multipart, "sec-fetch-site": "cross-site" },
      { ...multipart, origin: "https://evil.example" },
      { "content-type": multipart["content-type"], cookie: sameOrigin.cookie },
    ]) {
      const res = await mediaRoute.POST(
        req("POST", "/api/internal/admin/media", headers, "--x--"),
      );
      expect(res.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkout proxy", () => {
  it("accepts same-origin checkout (signed in and guest)", async () => {
    for (const cookie of ["mh_customer_session=ctok", ""]) {
      const res = await checkoutRoute.POST(
        req("POST", "/api/checkout", { ...sameOrigin, cookie }, "{}"),
      );
      expect(res.status).toBe(200);
    }
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ctok");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it("blocks a cross-site checkout even with a valid customer cookie", async () => {
    const res = await checkoutRoute.POST(
      req(
        "POST",
        "/api/checkout",
        { ...sameOrigin, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
        "{}",
      ),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Inventory: a new state-changing handler under app/api must be protected, or
// this fails. Mirrors the API's protected-routes spec.
describe("every mutating app/api handler is origin-protected", () => {
  const root = __dirname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") files.push(full);
    }
  };
  walk(root);

  it("finds the route handlers", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it.each(files.map((f) => [path.relative(root, f), f]))("%s", (_rel, file) => {
    const source = fs.readFileSync(file, "utf8");
    const mutates = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(
      source,
    );
    if (mutates) {
      expect(source).toContain("rejectUntrustedOrigin(request)");
    }
  });
});
