import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";
import {
  CODE_SENT_NOTICE,
  UNAVAILABLE_MESSAGE,
  afterComplete,
  afterStart,
  readApiMessage,
} from "./registration-state";

// SC4a — how the owner registration form reacts to each API answer.
const EMAIL = "owner@example.com";

describe("owner registration form state", () => {
  it("moves to the code step after a code request, with the same notice whatever the email", () => {
    expect(afterStart(EMAIL, { status: 202, message: null }, "email")).toEqual({
      step: "code",
      email: EMAIL,
      error: null,
      notice: CODE_SENT_NOTICE,
    });
  });

  it("keeps the step and explains a refused code request", () => {
    expect(
      afterStart(EMAIL, { status: 400, message: "Enter a valid email address." }, "email"),
    ).toEqual({ step: "email", email: EMAIL, error: "Enter a valid email address." });
    expect(afterStart(EMAIL, { status: 429, message: null }, "code")).toEqual({
      step: "code",
      email: EMAIL,
      error: TOO_MANY_ATTEMPTS_MESSAGE,
      notice: null,
    });
    // Disabled (404), quota (503) or anything unexpected: not available.
    for (const status of [404, 503, 500]) {
      expect(afterStart(EMAIL, { status, message: "internal" }, "email")).toMatchObject({
        error: UNAVAILABLE_MESSAGE,
      });
    }
    expect(afterStart(EMAIL, null, "email")).toMatchObject({
      error: expect.stringContaining("Could not reach the server") as unknown,
    });
  });

  it("finishes only on success; otherwise stays on the code step with the API's message", () => {
    expect(afterComplete(EMAIL, { status: 200, message: null })).toEqual({ step: "done" });
    expect(
      afterComplete(EMAIL, {
        status: 400,
        message: "That code is incorrect or has expired. Request a new code and try again.",
      }),
    ).toEqual({
      step: "code",
      email: EMAIL,
      error: "That code is incorrect or has expired. Request a new code and try again.",
      notice: null,
    });
    expect(afterComplete(EMAIL, { status: 409, message: null })).toMatchObject({
      step: "code",
      error: expect.stringContaining("Reload the page") as unknown,
    });
  });

  it("only shows short string messages from the API", () => {
    expect(readApiMessage({ message: "Short." })).toBe("Short.");
    expect(readApiMessage({ message: ["array"] })).toBeNull();
    expect(readApiMessage({ message: "x".repeat(301) })).toBeNull();
    expect(readApiMessage(null)).toBeNull();
  });
});
