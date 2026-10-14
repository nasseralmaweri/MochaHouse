import { TOO_MANY_ATTEMPTS_MESSAGE, passthroughHeaders } from "./rate-limit-message";

const upstream = (status: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status, headers });

describe("passthroughHeaders", () => {
  it("always returns the JSON content type", () => {
    expect(passthroughHeaders(upstream(200))).toEqual({ "Content-Type": "application/json" });
  });

  it("forwards a numeric Retry-After on a 429", () => {
    expect(passthroughHeaders(upstream(429, { "Retry-After": "42" }))).toEqual({
      "Content-Type": "application/json",
      "Retry-After": "42",
    });
  });

  it("drops a malformed Retry-After and never forwards it on other statuses", () => {
    expect(passthroughHeaders(upstream(429, { "Retry-After": "soon" }))).toEqual({
      "Content-Type": "application/json",
    });
    expect(passthroughHeaders(upstream(503, { "Retry-After": "5" }))).toEqual({
      "Content-Type": "application/json",
    });
  });
});

describe("TOO_MANY_ATTEMPTS_MESSAGE", () => {
  it("does not hint whether an account exists", () => {
    expect(TOO_MANY_ATTEMPTS_MESSAGE).not.toMatch(/account|password|email|exist/i);
  });
});
