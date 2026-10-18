import {
  STOREFRONT_MESSAGES,
  interpretStorefrontChange,
  liveSummary,
  validId,
  validReason,
} from "./storefront";

// SC4f-3a — the console's reading of storefront publishing answers.
describe("liveSummary", () => {
  it("never calls a published address live while host routing is off", () => {
    expect(liveSummary({ published: true, live: false }, false)).toMatch(/not live \(host routing is off\)/);
    expect(liveSummary({ published: true, live: true }, true)).toBe("Live");
    expect(liveSummary({ published: false, live: false }, true)).toBe("Not published");
    expect(liveSummary({ published: false, live: false }, false)).toBe("Not published");
    expect(liveSummary({ published: true, live: false }, true)).toBe(
      "Published in the registry — not live right now",
    );
  });
});

describe("interpretStorefrontChange", () => {
  it("returns the refreshed view on success", () => {
    const view = { tenant: { id: "t" } };
    expect(interpretStorefrontChange(200, view)).toEqual({ kind: "ok", view });
  });

  it("asks for a fresh sign-in only when the API says so", () => {
    expect(interpretStorefrontChange(401, { code: "REAUTHENTICATION_REQUIRED" })).toEqual({ kind: "reauth" });
    expect(interpretStorefrontChange(401, {})).toEqual({
      kind: "error",
      message: STOREFRONT_MESSAGES.sessionEnded,
    });
  });

  it("lists the unmet publishing checks in plain words", () => {
    const outcome = interpretStorefrontChange(409, {
      code: "STOREFRONT_NOT_ELIGIBLE",
      missing: ["menu_available", "business_active"],
    });
    expect(outcome).toEqual({
      kind: "error",
      message: expect.stringMatching(/^Not ready to publish\. Still needed: Business is active.*menu/),
    });
  });

  it("passes the API's own conflict and validation messages through, bounded", () => {
    expect(interpretStorefrontChange(409, { message: "This address is already assigned." })).toEqual({
      kind: "error",
      message: "This address is already assigned.",
    });
    expect(interpretStorefrontChange(400, { message: "x".repeat(400) })).toEqual({
      kind: "error",
      message: "x".repeat(300),
    });
  });

  it("maps permission, missing, rate limit and outage answers", () => {
    expect(interpretStorefrontChange(403, {})).toMatchObject({ message: expect.stringMatching(/storefront\.manage/) });
    expect(interpretStorefrontChange(404, {})).toMatchObject({ message: STOREFRONT_MESSAGES.notFound });
    expect(interpretStorefrontChange(429, {})).toMatchObject({ message: STOREFRONT_MESSAGES.tooMany });
    expect(interpretStorefrontChange(null, null)).toMatchObject({ message: STOREFRONT_MESSAGES.unavailable });
  });
});

describe("validReason / validId", () => {
  it("bounds reasons and ids", () => {
    expect(validReason("   short   ")).toBe(false);
    expect(validReason("A proper reason")).toBe(true);
    expect(validReason("x".repeat(501))).toBe(false);
    expect(validId("01a0db02-f800-7000-8000-000000000001")).toBe(true);
    for (const bad of ["../x", "a/b", "", "x".repeat(65), null, 1]) {
      expect(validId(bad)).toBe(false);
    }
  });
});
