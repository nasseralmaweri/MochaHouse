import {
  ITEM_STATE_LABEL,
  STATUS_PRESENTATION,
  eventTypeLabel,
  formatAge,
  reasonLabel,
  reasonWithCode,
  severityTone,
} from "./notification-health";

describe("formatAge", () => {
  it.each([
    [null, "—"],
    [0, "under a minute"],
    [59, "under a minute"],
    [60, "1 min"],
    [600, "10 min"],
    [3599, "59 min"],
    [3600, "1 h"],
    [3660, "1 h 1 min"],
    [7200 + 1800, "2 h 30 min"],
    [24 * 3600, "1 d"],
    [24 * 3600 + 5 * 3600, "1 d 5 h"],
    [3 * 24 * 3600, "3 d"],
  ])("%p -> %p", (seconds, expected) => {
    expect(formatAge(seconds as number | null)).toBe(expected);
  });
});

describe("status wording", () => {
  it("distinguishes normal operation from a problem", () => {
    expect(STATUS_PRESENTATION.ok.tone).toBe("ok");
    expect(STATUS_PRESENTATION.ok.summary).toMatch(/retrying are part of normal operation/);
    expect(STATUS_PRESENTATION.warning.tone).toBe("warning");
    expect(STATUS_PRESENTATION.critical.tone).toBe("critical");
    const labels = Object.values(STATUS_PRESENTATION).map((p) => p.label);
    expect(new Set(labels).size).toBe(3);
  });

  it("an informational note is not styled as a problem", () => {
    expect(severityTone("info")).toBe("info");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("critical")).toBe("critical");
  });

  it("labels every item state", () => {
    expect(Object.keys(ITEM_STATE_LABEL).sort()).toEqual(["dead-lettered", "delayed", "retrying"]);
  });
});

describe("labels", () => {
  it("words the notification types and keeps unknown ones visible", () => {
    expect(eventTypeLabel("order.status.ready")).toBe("Order ready email");
    expect(eventTypeLabel("something.new")).toBe("something.new");
  });

  it("explains known reason codes in plain language and never hides an unknown one", () => {
    expect(reasonLabel("NO_RECIPIENT")).toBe("No email address for this order");
    expect(reasonLabel("BRAND_NEW_CODE")).toBe("BRAND_NEW_CODE");
    expect(reasonLabel(null)).toBe("No reason recorded");
    expect(reasonWithCode("THROTTLING")).toBe(
      "The email provider asked us to slow down (THROTTLING)",
    );
    expect(reasonWithCode("BRAND_NEW_CODE")).toBe("BRAND_NEW_CODE");
  });
});
