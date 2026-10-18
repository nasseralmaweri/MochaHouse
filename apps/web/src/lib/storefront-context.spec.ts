import {
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
} from "@mocha-house/contracts";

const incoming = new Headers();
jest.mock("server-only", () => ({}));
jest.mock("next/headers", () => ({ headers: async () => incoming }));

import {
  requestStorefrontHost,
  signStorefrontContext,
  signedStorefrontHeaders,
  storefrontApiFetch,
} from "./storefront-context";
import * as menuRoute from "../app/api/locations/[locationId]/menu/route";

const SECRET = "a-storefront-secret-that-is-at-least-32-chars";
const NOW_MS = 1_800_000_000_000;
const ON = {
  STOREFRONT_HOST_ROUTING_ENABLED: "true",
  STOREFRONT_CONTEXT_SECRET: SECRET,
} as unknown as NodeJS.ProcessEnv;

const source = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()] ?? null,
});

describe("signStorefrontContext", () => {
  // The same known answer as the API's spec (apps/api/src/tenancy/
  // storefront-context.spec.ts): the two implementations must agree.
  it("matches the published test vector shared with the API", () => {
    expect(
      signStorefrontContext(
        "0123456789abcdef0123456789abcdef",
        "mocha.shop.test",
        1_800_000_000,
      ),
    ).toBe("1db54d133e3e0fa3d4962767d8d42985949054473dbf11f40f67649828b6bf50");
  });
});

describe("requestStorefrontHost", () => {
  it("uses the Host header by default, normalized", () => {
    expect(requestStorefrontHost(source({ host: "Mocha.Shop.Test:3000" }), ON)).toBe(
      "mocha.shop.test",
    );
    expect(requestStorefrontHost(source({ host: "10.0.0.1" }), ON)).toBeNull();
    expect(requestStorefrontHost(source({}), ON)).toBeNull();
  });

  it("ignores X-Forwarded-Host unless the deployment names it", () => {
    expect(
      requestStorefrontHost(
        source({ host: "mocha.shop.test", "x-forwarded-host": "evil.shop.test" }),
        ON,
      ),
    ).toBe("mocha.shop.test");
  });

  it("reads a configured forwarded header that many trusted entries from the end", () => {
    const env = {
      ...ON,
      STOREFRONT_FORWARDED_HOST_HEADER: "X-Forwarded-Host",
    } as NodeJS.ProcessEnv;
    expect(
      requestStorefrontHost(
        source({
          host: "internal.lb.test",
          "x-forwarded-host": "spoofed.shop.test, mocha.shop.test",
        }),
        env,
      ),
    ).toBe("mocha.shop.test");
    expect(
      requestStorefrontHost(
        source({
          "x-forwarded-host": "spoofed.shop.test, mocha.shop.test",
        }),
        { ...env, STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS: "2" } as NodeJS.ProcessEnv,
      ),
    ).toBe("spoofed.shop.test");
    // Fewer entries than declared proxies, or a bad hop count: nothing.
    expect(
      requestStorefrontHost(
        source({ "x-forwarded-host": "mocha.shop.test" }),
        { ...env, STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS: "2" } as NodeJS.ProcessEnv,
      ),
    ).toBeNull();
    expect(
      requestStorefrontHost(
        source({ "x-forwarded-host": "mocha.shop.test" }),
        { ...env, STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS: "0" } as NodeJS.ProcessEnv,
      ),
    ).toBeNull();
    // A configured header that is absent never falls back to Host.
    expect(
      requestStorefrontHost(source({ host: "mocha.shop.test" }), env),
    ).toBeNull();
  });
});

describe("signedStorefrontHeaders", () => {
  it("sends nothing while routing is off", () => {
    expect(
      signedStorefrontHeaders(source({ host: "mocha.shop.test" }), {
        STOREFRONT_CONTEXT_SECRET: SECRET,
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({});
  });

  it("signs the normalized hostname with the current time", () => {
    expect(
      signedStorefrontHeaders(source({ host: "Mocha.Shop.Test" }), ON, NOW_MS),
    ).toEqual({
      [STOREFRONT_HOST_HEADER]: "mocha.shop.test",
      [STOREFRONT_HOST_TIMESTAMP_HEADER]: "1800000000",
      [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
        SECRET,
        "mocha.shop.test",
        1_800_000_000,
      ),
    });
  });

  it("sends no context for an unusable hostname (the API then refuses)", () => {
    expect(signedStorefrontHeaders(source({ host: "[::1]" }), ON)).toEqual({});
  });

  it("refuses to run with routing on and no usable secret", () => {
    expect(() =>
      signedStorefrontHeaders(source({ host: "mocha.shop.test" }), {
        STOREFRONT_HOST_ROUTING_ENABLED: "1",
        STOREFRONT_CONTEXT_SECRET: "short",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/STOREFRONT_CONTEXT_SECRET/);
  });
});

describe("storefrontApiFetch and the menu proxy", () => {
  const fetchMock = jest.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.API_URL = "http://api.test/api/v1";
    for (const name of [...incoming.keys()]) incoming.delete(name);
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is plain fetch while routing is off", async () => {
    delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
    incoming.set("host", "mocha.shop.test");
    const init = { method: "POST", headers: { Authorization: "Bearer t" } };
    await storefrontApiFetch("http://api.test/x", init);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/x", init);
  });

  it("adds the signed context of the incoming request, keeps the caller's headers, never caches", async () => {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = "1";
    process.env.STOREFRONT_CONTEXT_SECRET = SECRET;
    incoming.set("host", "bravo.shop.test");
    await storefrontApiFetch("http://api.test/x", {
      headers: {
        Authorization: "Bearer t",
        // A caller can never pre-set the storefront it claims.
        [STOREFRONT_HOST_HEADER]: "mocha.shop.test",
      },
    });
    const [, init] = fetchMock.mock.calls[0];
    const sent = init.headers as Headers;
    expect(sent.get("authorization")).toBe("Bearer t");
    expect(sent.get(STOREFRONT_HOST_HEADER)).toBe("bravo.shop.test");
    expect(sent.get(STOREFRONT_HOST_SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(init.cache).toBe("no-store");
  });

  it("the cart's menu read goes through the web server with the shopper's storefront", async () => {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = "1";
    process.env.STOREFRONT_CONTEXT_SECRET = SECRET;
    incoming.set("host", "bravo.shop.test");
    const res = await menuRoute.GET(
      new Request("http://bravo.shop.test/api/locations/loc-1/menu") as never,
      { params: Promise.resolve({ locationId: "loc-1" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("http://api.test/api/v1/locations/loc-1/menu");
    expect((init.headers as Headers).get(STOREFRONT_HOST_HEADER)).toBe(
      "bravo.shop.test",
    );
  });

  it("the menu proxy forwards only an id-shaped location, never path pieces", async () => {
    for (const locationId of ["..", ".", "a/b", "a?b", "", "x".repeat(65)]) {
      const res = await menuRoute.GET(
        new Request("http://bravo.shop.test/api/locations/x/menu") as never,
        { params: Promise.resolve({ locationId }) },
      );
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a misconfigured deployment fails loudly instead of looking like an outage", async () => {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = "1";
    delete process.env.STOREFRONT_CONTEXT_SECRET;
    incoming.set("host", "bravo.shop.test");
    await expect(
      menuRoute.GET(
        new Request("http://bravo.shop.test/api/locations/l/menu") as never,
        { params: Promise.resolve({ locationId: "l" }) },
      ),
    ).rejects.toThrow(/STOREFRONT_CONTEXT_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a caller's storefront headers even when no context can be signed", async () => {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = "1";
    process.env.STOREFRONT_CONTEXT_SECRET = SECRET;
    incoming.set("host", "10.0.0.1");
    await storefrontApiFetch("http://api.test/x", {
      headers: { [STOREFRONT_HOST_HEADER]: "mocha.shop.test" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Headers).get(STOREFRONT_HOST_HEADER)).toBeNull();
  });

  it("the menu proxy passes the API's refusal through, uncached", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "STOREFRONT_NOT_FOUND" }), {
          status: 404,
        }),
    );
    const res = await menuRoute.GET(
      new Request("http://nobody.shop.test/api/locations/l/menu") as never,
      { params: Promise.resolve({ locationId: "l" }) },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ code: "STOREFRONT_NOT_FOUND" });
  });

  it("names a location this storefront does not offer (the API's empty answer) with its own code", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    const res = await menuRoute.GET(
      new Request("http://bravo.shop.test/api/locations/l/menu") as never,
      { params: Promise.resolve({ locationId: "l" }) },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).code).toBe("LOCATION_NOT_IN_STOREFRONT");
  });
});
