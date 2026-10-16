import {
  PLATFORM_CHALLENGE_COOKIE_BASE,
  PLATFORM_CHALLENGE_MAX_AGE_SECONDS,
  PLATFORM_SESSION_COOKIE_BASE,
  clearPlatformCookie,
  platformCookieName,
  platformCookieOptions,
  platformSessionMaxAge,
} from "./cookies";
import {
  PLATFORM_MESSAGES,
  PLATFORM_NOTICES,
  groupSecret,
  interpretCode,
  interpretMfaDisplay,
  interpretMfaSetup,
  interpretSignIn,
  isSixDigitCode,
  noticeFrom,
  normaliseCode,
  sessionStateFromStatus,
} from "./sign-in-flow";
// lib/internal-auth/session.ts is server-only (it cannot load under Jest);
// its tenant-staff session cookie name is pinned here instead.
const INTERNAL_SESSION_COOKIE_BASE = "mh_internal_session";

// SC1b — the CENTERIVO platform-operator sign-in in the web tier: cookie
// policy, how every API answer is read (never leaking a provider detail,
// never treating anything but a complete answer as a session), and the
// portal's session states.

const env = (values: Record<string, string>) =>
  values as unknown as NodeJS.ProcessEnv;
const HANDLE = "A".repeat(43);

describe("platform cookies", () => {
  it("are separate from the tenant-staff and customer session cookies", () => {
    const names = [PLATFORM_SESSION_COOKIE_BASE, PLATFORM_CHALLENGE_COOKIE_BASE];
    expect(new Set(names).size).toBe(2);
    expect(names).not.toContain(INTERNAL_SESSION_COOKIE_BASE);
    for (const name of names) expect(name).toMatch(/^cx_platform_/);
  });

  it("are HttpOnly, SameSite=Strict, Path=/, Secure and __Host- prefixed in production", () => {
    expect(platformCookieOptions(120, env({ NODE_ENV: "production" }))).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 120,
    });
    expect(
      platformCookieName(PLATFORM_SESSION_COOKIE_BASE, env({ NODE_ENV: "production" })),
    ).toBe("__Host-cx_platform_session");
    expect(platformCookieOptions(120, env({ NODE_ENV: "development" })).secure).toBe(
      false,
    );
  });

  it("the challenge lives no longer than the server-side challenge (3 minutes)", () => {
    expect(PLATFORM_CHALLENGE_MAX_AGE_SECONDS).toBe(180);
  });

  it("the session cookie never outlives the token (and is capped at one hour)", () => {
    expect(platformSessionMaxAge(3600)).toBe(3540);
    expect(platformSessionMaxAge(86400)).toBe(3540);
    expect(platformSessionMaxAge(30)).toBe(0);
    expect(platformSessionMaxAge(0)).toBe(0);
    expect(platformSessionMaxAge(Number.NaN)).toBe(0);
  });

  it("clearing expires the cookie with its own attributes (so a __Host- cookie really goes)", () => {
    const set = jest.fn();
    clearPlatformCookie({ set }, PLATFORM_SESSION_COOKIE_BASE, env({ NODE_ENV: "production" }));
    expect(set).toHaveBeenCalledWith("__Host-cx_platform_session", "", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
      expires: new Date(0),
    });
  });
});

describe("reading the sign-in API", () => {
  it("password accepted -> the MFA step or authenticator enrolment, with the opaque handle only", () => {
    expect(interpretSignIn(200, { status: "mfa-required", challenge: HANDLE })).toEqual({
      kind: "mfa",
      challenge: HANDLE,
    });
    expect(
      interpretSignIn(200, { status: "mfa-setup-required", challenge: HANDLE }),
    ).toEqual({ kind: "enrol", challenge: HANDLE });
  });

  it("a 200 that is not a well-formed step (e.g. a token, a bad handle) is never treated as progress", () => {
    for (const body of [
      { idToken: "x", expiresInSeconds: 3600 },
      { status: "mfa-required", challenge: "short" },
      { status: "signed-in", challenge: HANDLE },
      null,
    ]) {
      expect(interpretSignIn(200, body)).toEqual({
        kind: "error",
        message: PLATFORM_MESSAGES.unavailable,
      });
    }
  });

  it("invalid or missing credentials are one generic message; 403 is the account-setup notice; 429 is throttled", () => {
    expect(interpretSignIn(401, { message: "Invalid email or password." })).toEqual({
      kind: "error",
      message: "Invalid email or password.",
    });
    expect(interpretSignIn(400, {})).toEqual({
      kind: "error",
      message: "Invalid email or password.",
    });
    expect(interpretSignIn(403, {})).toEqual({ kind: "notice", notice: "account-setup" });
    expect(interpretSignIn(429, {})).toEqual({
      kind: "error",
      message: PLATFORM_MESSAGES.tooMany,
    });
  });

  it("never shows an API or provider message: 5xx and anything unknown are the generic unavailable message", () => {
    for (const status of [500, 502, 503, 418]) {
      const step = interpretSignIn(status, {
        message: "NotAuthorizedException: Cognito says no",
      });
      expect(step).toEqual({ kind: "error", message: PLATFORM_MESSAGES.unavailable });
    }
  });

  it("enrolment: issuing the secret returns only the next handle", () => {
    expect(interpretMfaSetup(200, { challenge: HANDLE })).toEqual({
      kind: "issued",
      challenge: HANDLE,
    });
    expect(interpretMfaSetup(200, { challenge: "short" }).kind).toBe("error");
    expect(interpretMfaSetup(401, {})).toEqual({ kind: "notice", notice: "restart" });
  });

  it("enrolment display: only a well-formed base32 secret and otpauth URI are ever rendered", () => {
    const display = {
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/CENTERIVO%3Aop?secret=JBSWY3DPEHPK3PXP",
    };
    expect(interpretMfaDisplay(200, display)).toEqual(display);
    expect(interpretMfaDisplay(200, { ...display, secret: "not base32!" })).toBeNull();
    expect(
      interpretMfaDisplay(200, { ...display, otpauthUri: "javascript:alert(1)" }),
    ).toBeNull();
    expect(interpretMfaDisplay(401, display)).toBeNull();
    expect(interpretMfaDisplay(200, null)).toBeNull();
  });

  it("code step: a session only from a complete answer; a spent challenge restarts; a refused account is 'not permitted'", () => {
    expect(interpretCode(200, { idToken: "tok", expiresInSeconds: 3600 })).toEqual({
      kind: "session",
      idToken: "tok",
      expiresInSeconds: 3600,
    });
    expect(interpretCode(200, { idToken: "", expiresInSeconds: 3600 }).kind).toBe("error");
    expect(interpretCode(200, {}).kind).toBe("error");
    expect(interpretCode(401, {})).toEqual({ kind: "notice", notice: "restart" });
    expect(interpretCode(403, {})).toEqual({ kind: "notice", notice: "not-permitted" });
    // A malformed code leaves the challenge intact: stay on the page.
    expect(interpretCode(400, {})).toEqual({
      kind: "error",
      message: PLATFORM_MESSAGES.codeFormat,
    });
    expect(interpretCode(503, { message: "detail" })).toEqual({
      kind: "error",
      message: PLATFORM_MESSAGES.unavailable,
    });
  });
});

describe("codes, notices and session states", () => {
  it("accepts six digits, tolerating spaces and a dash", () => {
    expect(isSixDigitCode(normaliseCode("123 456"))).toBe(true);
    expect(isSixDigitCode(normaliseCode("123-456"))).toBe(true);
    for (const raw of ["12345", "1234567", "12a456", "", null]) {
      expect(isSixDigitCode(normaliseCode(raw))).toBe(false);
    }
  });

  it("only known notices are shown (a crafted query string cannot inject text)", () => {
    expect(noticeFrom("expired")).toBe("expired");
    expect(noticeFrom("<script>")).toBeNull();
    expect(noticeFrom(["expired"])).toBeNull();
    expect(Object.values(PLATFORM_NOTICES).join(" ")).not.toMatch(
      /billing|security|disabled|suspend/i,
    );
  });

  it("groups the authenticator secret for manual entry", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABCDEFG==")).toBe("ABCD EFG");
  });

  it("maps GET /platform/me to the portal's states, failing closed", () => {
    expect(sessionStateFromStatus(200)).toBe("signed-in");
    expect(sessionStateFromStatus(401)).toBe("expired");
    expect(sessionStateFromStatus(403)).toBe("forbidden");
    for (const status of [500, 503, 404, null]) {
      expect(sessionStateFromStatus(status)).toBe("unavailable");
    }
  });
});
