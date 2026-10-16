import type { PlatformPlan } from "@mocha-house/contracts";
import {
  SUBSCRIPTION_MESSAGES,
  addOnCandidates,
  assignableVersions,
  interpretChange,
  moduleLabel,
  validatePlanForm,
  versionLabel,
} from "./subscriptions";

// SC2a — the Plans and Subscription screens' logic: only PUBLISHED versions
// are offered, add-ons exclude what is already available, plan form checks,
// and every API answer maps to a message that never shows a server detail.

const plan = (overrides: Partial<PlatformPlan> = {}): PlatformPlan => ({
  id: "p1",
  key: "growth",
  name: "Growth",
  description: null,
  versions: [
    { id: "v3", version: 3, status: "DRAFT", moduleKeys: ["crm"], publishedAt: null, retiredAt: null, subscriberCount: 0 },
    { id: "v2", version: 2, status: "PUBLISHED", moduleKeys: ["crm", "loyalty"], publishedAt: "x", retiredAt: null, subscriberCount: 4 },
    { id: "v1", version: 1, status: "RETIRED", moduleKeys: ["loyalty"], publishedAt: "x", retiredAt: "y", subscriberCount: 1 },
  ],
  prices: [],
  ...overrides,
});

describe("plans", () => {
  it("offers only published versions, labelled by plan and version", () => {
    expect(assignableVersions([plan()])).toEqual([
      { id: "v2", label: "Growth v2", moduleKeys: ["crm", "loyalty"] },
    ]);
    expect(versionLabel({ name: "Founding" }, { version: 1 })).toBe("Founding v1");
  });

  it("offers as add-ons only optional modules that are not already available", () => {
    expect(addOnCandidates(["core", "crm", "loyalty"])).not.toEqual(
      expect.arrayContaining(["crm", "loyalty"]),
    );
    expect(addOnCandidates(["core"])).toContain("giftcards");
    expect(addOnCandidates(["core"])).not.toContain("core");
  });

  it("labels modules from the shared catalog", () => {
    expect(moduleLabel("core")).toBe("Core");
    expect(moduleLabel("giftcards")).toBe("Gift cards");
  });

  it("checks the plan form like the API", () => {
    expect(validatePlanForm("growth-plus", "Growth Plus")).toEqual({});
    expect(validatePlanForm("Bad Key", "x")).toEqual({
      key: expect.any(String),
      name: expect.any(String),
    });
  });
});

describe("reading the API's answer", () => {
  it("200 / 201 with a body is a result", () => {
    expect(interpretChange(201, { id: "p1" })).toEqual({ kind: "ok", data: { id: "p1" } });
    expect(interpretChange(200, null)).toEqual({ kind: "error", message: SUBSCRIPTION_MESSAGES.unavailable });
  });

  it("a stale sign-in asks to sign in again", () => {
    expect(interpretChange(401, { code: "REAUTHENTICATION_REQUIRED" })).toEqual({ kind: "reauth" });
    expect(interpretChange(401, {})).toEqual({ kind: "error", message: SUBSCRIPTION_MESSAGES.sessionEnded });
  });

  it("maps each conflict code to its own message", () => {
    for (const [code, message] of [
      ["PLAN_KEY_TAKEN", SUBSCRIPTION_MESSAGES.keyTaken],
      ["PLAN_DRAFT_EXISTS", SUBSCRIPTION_MESSAGES.draftExists],
      ["PLAN_VERSION_NOT_DRAFT", SUBSCRIPTION_MESSAGES.notDraft],
      ["PLAN_VERSION_NOT_PUBLISHED", SUBSCRIPTION_MESSAGES.notPublished],
      ["NO_SUBSCRIPTION", SUBSCRIPTION_MESSAGES.noSubscription],
      ["ADDON_IN_PLAN", SUBSCRIPTION_MESSAGES.addonInPlan],
      ["SUBSCRIPTION_BILLED", SUBSCRIPTION_MESSAGES.billed],
      ["SOMETHING_NEW", SUBSCRIPTION_MESSAGES.unavailable],
    ] as const) {
      expect(interpretChange(409, { code })).toEqual({ kind: "error", message });
    }
  });

  it("never shows a server detail: fixed messages, or the API's own bounded 400 text", () => {
    expect(interpretChange(403, {})).toEqual({ kind: "error", message: SUBSCRIPTION_MESSAGES.denied });
    expect(interpretChange(404, {})).toEqual({ kind: "error", message: SUBSCRIPTION_MESSAGES.notFound });
    expect(interpretChange(429, {})).toEqual({ kind: "error", message: SUBSCRIPTION_MESSAGES.tooMany });
    for (const status of [500, 503, null]) {
      expect(interpretChange(status, { message: "P2002 at …" })).toEqual({
        kind: "error",
        message: SUBSCRIPTION_MESSAGES.unavailable,
      });
    }
    const long = interpretChange(400, { message: "x".repeat(400) });
    expect(long.kind === "error" && long.message.length).toBe(200);
  });
});
