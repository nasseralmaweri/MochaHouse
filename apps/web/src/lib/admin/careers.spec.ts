import {
  EMPLOYMENT_TYPE_OPTIONS,
  employmentTypeLabel,
  formatJobDate,
  jobLocationLabel,
  jobLocationLabelFromName,
  jobStatusLabel,
  jobStatusTone,
} from "./careers";

describe("job status", () => {
  it("labels and tones each status", () => {
    expect(jobStatusLabel("DRAFT")).toBe("Draft");
    expect(jobStatusLabel("PUBLISHED")).toBe("Published");
    expect(jobStatusLabel("ARCHIVED")).toBe("Archived");
    expect(jobStatusTone("PUBLISHED")).toBe("positive");
    expect(jobStatusTone("DRAFT")).toBe("warning");
    expect(jobStatusTone("ARCHIVED")).toBe("neutral");
  });
});

describe("employment type", () => {
  it("labels all four types including SEASONAL", () => {
    expect(employmentTypeLabel("FULL_TIME")).toBe("Full time");
    expect(employmentTypeLabel("PART_TIME")).toBe("Part time");
    expect(employmentTypeLabel("TEMPORARY")).toBe("Temporary");
    expect(employmentTypeLabel("SEASONAL")).toBe("Seasonal");
  });

  it("exposes select options in order", () => {
    expect(EMPLOYMENT_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      "FULL_TIME",
      "PART_TIME",
      "TEMPORARY",
      "SEASONAL",
    ]);
    expect(EMPLOYMENT_TYPE_OPTIONS.find((o) => o.value === "SEASONAL")?.label).toBe(
      "Seasonal",
    );
  });
});

describe("location label", () => {
  it("names the location, or 'Corporate' for an HQ role", () => {
    expect(jobLocationLabel({ id: "l1", name: "Dearborn Heights" })).toBe(
      "Dearborn Heights",
    );
    expect(jobLocationLabel(null)).toBe("Corporate");
    expect(jobLocationLabelFromName("Detroit")).toBe("Detroit");
    expect(jobLocationLabelFromName(null)).toBe("Corporate");
  });
});

describe("formatJobDate", () => {
  it("formats an ISO date and handles null", () => {
    expect(formatJobDate("2026-03-15T09:00:00.000Z")).toBe("Mar 15, 2026");
    expect(formatJobDate(null)).toBe("—");
  });
});
