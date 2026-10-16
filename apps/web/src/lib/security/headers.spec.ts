import { buildHeaderRules, hstsHeader } from "./headers";

const env = (values: Record<string, string>) =>
  values as unknown as NodeJS.ProcessEnv;

const find = (rules: ReturnType<typeof buildHeaderRules>, source: string) =>
  Object.fromEntries(
    (rules.find((r) => r.source === source)?.headers ?? []).map((h) => [
      h.key,
      h.value,
    ]),
  );

describe("buildHeaderRules", () => {
  const rules = buildHeaderRules(env({}));

  it("applies the baseline to every path", () => {
    const h = find(rules, "/:path*");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });

  it("sets no full CSP, only framing", () => {
    const csp = find(rules, "/:path*")["Content-Security-Policy"];
    expect(csp).not.toMatch(/script-src|default-src/);
  });

  it("stops order-confirmation and account URLs leaking or being cached", () => {
    for (const source of ["/order/confirmation/:path*", "/account/:path*"]) {
      const h = find(rules, source);
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["Cache-Control"]).toBe("no-store");
    }
  });

  it("keeps the CENTERIVO platform console uncached, unreferred and unindexed (SC1b)", () => {
    for (const source of ["/platform", "/platform/:path*"]) {
      const h = find(rules, source);
      expect(h["Cache-Control"]).toBe("no-store");
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["X-Robots-Tag"]).toBe("noindex, nofollow");
    }
  });

  it("marks API responses uncacheable", () => {
    expect(find(rules, "/api/:path*")["Cache-Control"]).toBe("no-store");
  });

  it("omits HSTS unless configured", () => {
    expect(find(rules, "/:path*")["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("hstsHeader", () => {
  it("is opt-in and validates the value", () => {
    expect(hstsHeader(env({}))).toEqual([]);
    expect(hstsHeader(env({ HSTS_MAX_AGE_SECONDS: "0" }))).toEqual([]);
    expect(hstsHeader(env({ HSTS_MAX_AGE_SECONDS: "abc" }))).toEqual([]);
    expect(hstsHeader(env({ HSTS_MAX_AGE_SECONDS: "-5" }))).toEqual([]);
    expect(hstsHeader(env({ HSTS_MAX_AGE_SECONDS: "31536000" }))).toEqual([
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
    ]);
  });
});
