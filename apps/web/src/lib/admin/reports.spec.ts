import {
  buildReportQuery,
  checkReportDateRange,
  currentBusinessDate,
  normalizeReportFilters,
  type ReportFilters,
} from "./reports";

describe("currentBusinessDate", () => {
  it("returns a well-formed YYYY-MM-DD date", () => {
    expect(currentBusinessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("normalizeReportFilters", () => {
  it("defaults startDate and endDate to today's business date when absent", () => {
    const today = currentBusinessDate();
    expect(normalizeReportFilters({})).toEqual({
      startDate: today,
      endDate: today,
      locationId: null,
    });
  });

  it("keeps explicit dates and trims a locationId", () => {
    expect(
      normalizeReportFilters({
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        locationId: "  loc-1  ",
      }),
    ).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      locationId: "loc-1",
    });
  });

  it("treats a blank locationId as All locations (null)", () => {
    expect(
      normalizeReportFilters({
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        locationId: "   ",
      }).locationId,
    ).toBeNull();
  });

  it("takes the first value of a repeated param", () => {
    expect(
      normalizeReportFilters({
        startDate: ["2026-08-01", "2026-08-02"],
      }).startDate,
    ).toBe("2026-08-01");
  });
});

describe("checkReportDateRange", () => {
  it("accepts a valid ordered range", () => {
    expect(checkReportDateRange("2026-08-01", "2026-08-31")).toBeNull();
    expect(checkReportDateRange("2026-08-31", "2026-08-31")).toBeNull();
  });

  it("rejects a malformed start date", () => {
    expect(checkReportDateRange("2026-8-1", "2026-08-31")).toMatch(
      /start date/,
    );
  });

  it("rejects a malformed end date", () => {
    expect(checkReportDateRange("2026-08-01", "yesterday")).toMatch(
      /end date/,
    );
  });

  it("rejects an impossible calendar date", () => {
    expect(checkReportDateRange("2026-02-30", "2026-03-01")).toMatch(
      /start date/,
    );
  });

  it("rejects start after end", () => {
    expect(checkReportDateRange("2026-09-01", "2026-08-01")).toMatch(
      /on or before/,
    );
  });
});

describe("buildReportQuery", () => {
  it("serialises startDate and endDate, omitting locationId for All locations", () => {
    const filters: ReportFilters = {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      locationId: null,
    };
    expect(buildReportQuery(filters)).toBe(
      "?startDate=2026-08-01&endDate=2026-08-31",
    );
  });

  it("includes locationId when set", () => {
    const filters: ReportFilters = {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      locationId: "loc-1",
    };
    expect(buildReportQuery(filters)).toBe(
      "?startDate=2026-08-01&endDate=2026-08-31&locationId=loc-1",
    );
  });
});
