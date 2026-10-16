import {
  LIFECYCLE_MESSAGES,
  SUSPENSION_REASON_OPTIONS,
  confirmsSlug,
  describeImpact,
  interpretLifecycleChange,
  isSuspensionReason,
} from "./tenant-lifecycle";

// SC1e — the lifecycle panel's logic: reasons, the typed confirmation, the
// impact summary (counts only, plain words), and every API answer mapped to
// a message that never shows a server detail.

describe("suspension input", () => {
  it("offers exactly the three suspension reasons", () => {
    expect(SUSPENSION_REASON_OPTIONS.map((o) => o.value)).toEqual([
      "SECURITY",
      "BILLING",
      "REQUESTED",
    ]);
    expect(isSuspensionReason("BILLING")).toBe(true);
    for (const value of ["billing", "", "DELETED", null]) {
      expect(isSuspensionReason(value)).toBe(false);
    }
  });

  it("confirmation needs the slug exactly (surrounding spaces ignored)", () => {
    expect(confirmsSlug("  blue-bean ", "blue-bean")).toBe(true);
    for (const typed of ["Blue-Bean", "blue-bea", "", "blue bean"]) {
      expect(confirmsSlug(typed, "blue-bean")).toBe(false);
    }
  });
});

describe("impact summary", () => {
  it("always explains the storefront, staff access and that nothing is deleted", () => {
    const lines = describeImpact(0, 0);
    expect(lines).toHaveLength(3);
    expect(lines.join(" ")).toMatch(/online store/);
    expect(lines.join(" ")).toMatch(/Staff cannot sign in/);
    expect(lines.join(" ")).toMatch(/No data is deleted/);
  });

  it("adds open orders and held notifications only when there are any, with correct plurals", () => {
    const one = describeImpact(1, 1).join(" ");
    expect(one).toMatch(/1 open order is not finished/);
    expect(one).toMatch(/1 pending notification is held/);
    const many = describeImpact(3, 2).join(" ");
    expect(many).toMatch(/3 open orders are not finished/);
    expect(many).toMatch(/2 pending notifications are held/);
    expect(many).toMatch(/Nothing is cancelled or refunded/);
  });
});

describe("reading the API's answer", () => {
  it("200 is done, changed or not", () => {
    expect(interpretLifecycleChange(200, { changed: true })).toEqual({ kind: "done", changed: true });
    expect(interpretLifecycleChange(200, { changed: false })).toEqual({ kind: "done", changed: false });
    expect(interpretLifecycleChange(200, null)).toEqual({ kind: "done", changed: false });
  });

  it("a stale sign-in asks to sign in again; any other 401 is a session end", () => {
    expect(interpretLifecycleChange(401, { code: "REAUTHENTICATION_REQUIRED" })).toEqual({
      kind: "reauth",
    });
    expect(interpretLifecycleChange(401, {})).toEqual({
      kind: "error",
      message: LIFECYCLE_MESSAGES.sessionEnded,
    });
  });

  it("maps each conflict code to its own message", () => {
    const message = (code: string) => interpretLifecycleChange(409, { code });
    expect(message("TENANT_PROTECTED")).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.protected });
    expect(message("OWNER_ALREADY_SIGNED_IN")).toEqual({
      kind: "error",
      message: LIFECYCLE_MESSAGES.ownerSignedIn,
    });
    expect(message("OWNER_EMAIL_IN_USE")).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.emailInUse });
    expect(message("SOMETHING_ELSE")).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.unavailable });
  });

  it("never shows a server detail: only fixed messages, or the API's own bounded 400 text", () => {
    expect(interpretLifecycleChange(403, {})).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.denied });
    expect(interpretLifecycleChange(404, {})).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.notFound });
    expect(interpretLifecycleChange(429, {})).toEqual({ kind: "error", message: LIFECYCLE_MESSAGES.tooMany });
    for (const status of [500, 503, null]) {
      expect(interpretLifecycleChange(status, { message: "Prisma P2034 at …" })).toEqual({
        kind: "error",
        message: LIFECYCLE_MESSAGES.unavailable,
      });
    }
    const long = interpretLifecycleChange(400, { message: "x".repeat(400) });
    expect(long.kind === "error" && long.message.length).toBe(200);
  });
});
