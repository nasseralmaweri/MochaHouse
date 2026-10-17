import type { PlatformRegistrationControlView } from "@mocha-house/contracts";
import {
  availabilitySummary,
  interpretControlChange,
  onboardingFilters,
  onboardingQuery,
  quotaSummary,
  registrationFilters,
  registrationQuery,
  validReason,
} from "./onboarding";

const view = (overrides: Partial<PlatformRegistrationControlView> = {}): PlatformRegistrationControlView => ({
  flag: "ON",
  paused: false,
  accepting: true,
  lastChange: null,
  history: [],
  quota: { limit: 50, usedInWindow: 3, windowHours: 24, nextFreeAt: null, asOf: "2026-10-17T12:00:00.000Z" },
  issues: { expired: 0, stalled: 0, verifiedWithoutBusiness: 0 },
  ...overrides,
});

describe("platform onboarding presentation (SC4e)", () => {
  it("keeps only filters the API accepts from the URL", () => {
    expect(registrationFilters({ filter: "expired", createdFrom: "2026-10-01", page: "2" })).toEqual({
      filter: "expired",
      createdFrom: "2026-10-01",
      createdTo: "",
      page: 2,
    });
    expect(registrationFilters({ filter: "drop table", createdTo: "yesterday", page: "-1" })).toEqual({
      filter: "all",
      createdFrom: "",
      createdTo: "",
      page: 1,
    });
    expect(registrationQuery({ filter: "stalled", createdFrom: "", createdTo: "2026-10-17", page: 3 })).toBe(
      "filter=stalled&page=3&pageSize=20&createdTo=2026-10-17",
    );
    expect(onboardingFilters({ filter: "stuck", stuckDays: "14" })).toEqual({ filter: "stuck", stuckDays: 14, page: 1 });
    expect(onboardingFilters({ filter: ["missing-menu", "all"], stuckDays: "900" })).toEqual({
      filter: "missing-menu",
      stuckDays: 7,
      page: 1,
    });
    expect(onboardingQuery({ filter: "all", stuckDays: 7, page: 1 })).toBe("filter=all&stuckDays=7&page=1&pageSize=20");
  });

  it("states availability truthfully: the deployment switch wins over the pause", () => {
    expect(availabilitySummary(view())).toMatchObject({ tone: "positive", title: "Accepting new registrations" });
    expect(availabilitySummary(view({ paused: true, accepting: false }))).toMatchObject({
      tone: "warning",
      title: "New registrations are paused",
    });
    const off = availabilitySummary(view({ flag: "OFF", accepting: false }));
    expect(off.title).toBe("Registration is off for this deployment");
    expect(off.detail).toMatch(/cannot turn it on/);
    expect(availabilitySummary(view({ flag: "MISCONFIGURED", accepting: false })).detail).toMatch(/incomplete/);
    // On and not paused, but the rolling quota is used up: not "accepting".
    const full = availabilitySummary(
      view({ quota: { ...view().quota, usedInWindow: 50, nextFreeAt: "2026-10-18T09:30:00.000Z" } }),
    );
    expect(full).toMatchObject({ tone: "warning", title: "Limit reached: new registrations are blocked for now" });
    expect(full.detail).toMatch(/Oct 18, 2026, 9:30 AM UTC/);
  });

  it("labels the quota's rolling 24-hour window and when a place frees up", () => {
    expect(quotaSummary(view().quota)).toBe(
      "3 of 50 new registrations used in the last 24 hours (a rolling window, not a calendar day).",
    );
    expect(
      quotaSummary({ ...view().quota, usedInWindow: 50, nextFreeAt: "2026-10-18T09:30:00.000Z" }),
    ).toMatch(/limit is reached: the next place frees up at Oct 18, 2026, 9:30 AM UTC\./);
    expect(quotaSummary({ ...view().quota, limit: null })).toMatch(/invalid/);
  });

  it("interprets the API's answers to a pause or resume", () => {
    expect(interpretControlChange(200, view({ paused: true }))).toMatchObject({ kind: "ok" });
    expect(interpretControlChange(401, { code: "REAUTHENTICATION_REQUIRED" })).toEqual({ kind: "reauth" });
    expect(interpretControlChange(401, {})).toMatchObject({ kind: "error", message: expect.stringMatching(/session has ended/) });
    expect(interpretControlChange(403, {})).toMatchObject({ message: expect.stringMatching(/onboarding.manage/) });
    expect(interpretControlChange(409, { code: "REGISTRATION_CONTROL_UNCHANGED" })).toMatchObject({
      message: expect.stringMatching(/already in that state/),
    });
    expect(interpretControlChange(400, { message: "Give a reason of 10 to 500 characters." })).toMatchObject({
      message: "Give a reason of 10 to 500 characters.",
    });
    expect(interpretControlChange(null, null)).toMatchObject({ kind: "error" });
    expect(validReason("too short")).toBe(false);
    expect(validReason("  A real reason here  ")).toBe(true);
  });
});
