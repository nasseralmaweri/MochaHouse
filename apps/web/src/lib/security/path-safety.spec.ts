import {
  areSafeProxySegments,
  buildProxyTarget,
  isSafeProxySegment,
} from "./path-safety";

const API = "https://api.example/api/v1";

describe("isSafeProxySegment", () => {
  it.each(["orders", "123", "a-b_c", "digital-ordering", "report.csv", "a b"])(
    "accepts %p",
    (segment) => {
      expect(isSafeProxySegment(segment)).toBe(true);
    },
  );

  it.each([
    "",
    ".",
    "..",
    "%2e",
    "%2E",
    "%2e%2e",
    "%2E%2E",
    ".%2e",
    "%2e.",
    "%252e%252e", // double-encoded
    "%25252e%25252e", // triple-encoded
    "%252e",
    "..%2f",
    "%2e%2e%2f",
    "a%2fb",
    "a%2Fb",
    "a%252fb",
    "a/b",
    "a\\b",
    "a%5cb",
    "a%255cb",
    "...",
    " .. ",
    "%20..",
    "..;",
    "x;y",
    "a%00b",
    "a\u0000b",
    "a%0ab",
    "%",
    "%zz",
    "%c0%ae%c0%ae", // overlong utf-8 encoding of ".."
    "%e0%80%ae",
    "%25%32%65", // %2e encoded by percent-encoding each character
  ])("rejects %p", (segment) => {
    expect(isSafeProxySegment(segment)).toBe(false);
  });

  it("rejects pathological nesting beyond the decode bound", () => {
    let s = "%2e%2e";
    for (let i = 0; i < 20; i += 1) s = s.replace(/%/g, "%25");
    expect(isSafeProxySegment(s)).toBe(false);
  });
});

describe("areSafeProxySegments", () => {
  it("requires at least one segment", () => {
    expect(areSafeProxySegments([])).toBe(false);
    expect(areSafeProxySegments(["orders"])).toBe(true);
    expect(areSafeProxySegments(["orders", ".."])).toBe(false);
  });
});

describe("buildProxyTarget", () => {
  it("builds a target under the permitted prefix and keeps the query", () => {
    expect(
      buildProxyTarget(API, "admin", ["orders", "42", "advance"], "?locationId=x"),
    ).toBe("https://api.example/api/v1/admin/orders/42/advance?locationId=x");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(buildProxyTarget(`${API}/`, "admin", ["orders"], "")).toBe(
      "https://api.example/api/v1/admin/orders",
    );
  });

  // The reported behaviour: the URL parser collapses dot segments, so without a
  // guard `/admin/../internal/me` escapes to `/internal/me`.
  it("demonstrates the escape the guard prevents", () => {
    expect(new URL("https://api.example/api/v1/admin/../internal/me").pathname).toBe(
      "/api/v1/internal/me",
    );
  });

  it.each([
    [[".."]],
    [["..", "internal", "me"]],
    [["orders", "..", "..", "internal"]],
    [["%2e%2e", "internal", "me"]],
    [["%2E%2E", "internal"]],
    [[".", "orders"]],
    [["%252e%252e", "internal"]],
    [["..%2finternal"]],
    [["%2e%2e%2finternal%2fme"]],
    [["..\\internal"]],
    [["orders", "%2e%2e", "%2e%2e", "internal"]],
  ])("refuses traversal segments %j", (segments) => {
    expect(buildProxyTarget(API, "admin", segments, "")).toBeNull();
  });

  it("refuses an empty path (the bare prefix)", () => {
    expect(buildProxyTarget(API, "admin", [], "")).toBeNull();
  });

  it("refuses an invalid base URL", () => {
    expect(buildProxyTarget("not a url", "admin", ["orders"], "")).toBeNull();
  });

  it("never leaves the API origin", () => {
    const target = buildProxyTarget(API, "admin", ["orders"], "?next=//evil.example");
    expect(target && new URL(target).origin).toBe("https://api.example");
    expect(target).toBe("https://api.example/api/v1/admin/orders?next=//evil.example");
  });

  it("keeps an encoded, harmless segment encoded in the target", () => {
    expect(buildProxyTarget(API, "admin", ["a b"], "")).toBe(
      "https://api.example/api/v1/admin/a%20b",
    );
  });
});
