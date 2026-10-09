import {
  addDays,
  applicantsAttention,
  approvalsAttention,
  buildLocationRows,
  describeRange,
  businessToday,
  checklistExceptionAttention,
  checklistState,
  formatBusinessDate,
  inquiriesAttention,
  openTasksAttention,
  parseOverviewRange,
  prioritizeAttention,
  rangeDates,
  resolveOverviewScope,
  shortLocationName,
  waitingOrdersAttention,
} from "./overview";

const loc = (id: string, name = id) => ({
  id,
  name,
  slug: id,
  isActive: true,
  isDigitalOrderingEnabled: true,
});

describe("overview scope", () => {
  it("maps corporate context to company-wide", () => {
    expect(resolveOverviewScope({ kind: "corporate" })).toEqual({
      kind: "company",
    });
  });
  it("keeps a concrete location, forbidden and none distinct", () => {
    const l = loc("a");
    expect(resolveOverviewScope({ kind: "location", location: l })).toEqual({
      kind: "location",
      location: l,
    });
    expect(
      resolveOverviewScope({ kind: "forbidden", requestedId: "x" }).kind,
    ).toBe("forbidden");
    expect(resolveOverviewScope({ kind: "none" }).kind).toBe("none");
  });
});

describe("business calendar", () => {
  it("uses the business time zone, not UTC", () => {
    // 02:30 UTC on Oct 7 is still Oct 6 evening in Detroit.
    expect(businessToday(new Date("2026-10-07T02:30:00Z"))).toBe("2026-10-06");
    expect(businessToday(new Date("2026-10-07T12:00:00Z"))).toBe("2026-10-07");
  });
  it("computes inclusive ranges across month boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(rangeDates("today", "2026-10-07")).toEqual({
      startDate: "2026-10-07",
      endDate: "2026-10-07",
    });
    expect(rangeDates("7d", "2026-10-07")).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-07",
    });
    expect(rangeDates("30d", "2026-10-07").startDate).toBe("2026-09-08");
  });
  it("falls back to today for an unknown range", () => {
    expect(parseOverviewRange("7d")).toBe("7d");
    expect(parseOverviewRange("forever")).toBe("today");
    expect(parseOverviewRange(null)).toBe("today");
  });
  it("describes a period in words", () => {
    expect(describeRange("today", "2026-10-07")).toBe("Today");
    expect(describeRange("7d", "2026-10-07")).toBe(
      "Last 7 days · Oct 1 – Oct 7",
    );
  });
  it("formats a business date", () => {
    expect(formatBusinessDate("2026-10-07")).toBe("Wednesday, October 7");
  });
});

describe("attention items", () => {
  it("produces nothing for zero counts", () => {
    expect(approvalsAttention(0, false)).toBeNull();
    expect(applicantsAttention(0, false)).toBeNull();
    expect(inquiriesAttention(0, false)).toBeNull();
    expect(openTasksAttention(loc("a"), { openCount: 0 })).toBeNull();
    expect(waitingOrdersAttention(loc("a"), [])).toBeNull();
  });
  it("marks a paged count as a lower bound", () => {
    expect(approvalsAttention(25, true)?.title).toContain("25+");
    expect(approvalsAttention(1, false)?.title).toContain(
      "1 approval request is waiting",
    );
  });
  it("counts only RECEIVED orders as waiting", () => {
    const item = waitingOrdersAttention(loc("a", "Ann Arbor"), [
      { status: "RECEIVED" },
      { status: "PREPARING" },
      { status: "RECEIVED" },
    ]);
    expect(item?.title).toContain("2 new orders are waiting");
    expect(item?.context).toBe("Ann Arbor");
  });
  const row = (id: string, o = 0, c = 0) => ({
    locationId: id,
    locationName: id.toUpperCase(),
    isActive: true,
    openingStarted: 1,
    openingCompleted: 0,
    openingCurrentExceptions: o,
    closingStarted: 0,
    closingCompleted: 0,
    closingCurrentExceptions: c,
  });
  it("surfaces checklist exceptions per location and can narrow to one", () => {
    const rows = [row("a", 1, 1), row("b"), row("c", 0, 2)];
    expect(
      checklistExceptionAttention(rows, null).map((i) => i.context),
    ).toEqual(["A", "C"]);
    expect(checklistExceptionAttention(rows, "c")).toHaveLength(1);
    expect(checklistExceptionAttention(rows, "a")[0].description).toBe(
      "Opening: 1 · Closing: 1",
    );
  });
  it("puts warnings before info, preserving order otherwise", () => {
    const out = prioritizeAttention([
      { id: "1", severity: "info", title: "", description: "" },
      { id: "2", severity: "warning", title: "", description: "" },
      { id: "3", severity: "warning", title: "", description: "" },
    ]);
    expect(out.map((i) => i.id)).toEqual(["2", "3", "1"]);
  });
});

describe("location rows", () => {
  const perf = (id: string, enabled = true) => ({
    locationId: id,
    locationName: id,
    isActive: true,
    isDigitalOrderingEnabled: enabled,
    totalOrders: 4,
    completedOrders: 2,
    completedPercent: 50,
    digitalSalesMinorUnits: 1000,
    averageOrderValueMinorUnits: 250,
  });
  it("derives checklist state without implying a miss", () => {
    expect(checklistState(0, 0)).toBe("not-recorded");
    expect(checklistState(1, 0)).toBe("in-progress");
    expect(checklistState(1, 1)).toBe("completed");
  });
  it("sorts locations needing a look first, then by name", () => {
    const rows = buildLocationRows(
      [perf("b"), perf("a"), perf("c", false)],
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(["c", "a", "b"]);
    expect(rows[0].flags).toEqual(["Online ordering off"]);
    expect(rows[1].checklist).toBeNull();
  });
  it("adds checklist exceptions as flags", () => {
    const rows = buildLocationRows(
      [perf("a")],
      [
        {
          locationId: "a",
          locationName: "a",
          isActive: true,
          openingStarted: 1,
          openingCompleted: 1,
          openingCurrentExceptions: 0,
          closingStarted: 1,
          closingCompleted: 0,
          closingCurrentExceptions: 2,
        },
      ],
    );
    expect(rows[0].flags).toEqual(["2 checklist exceptions"]);
    expect(rows[0].checklist).toEqual({
      opening: "completed",
      closing: "in-progress",
      exceptions: 2,
    });
  });
});

describe("shortLocationName", () => {
  it("drops a leading business name", () => {
    expect(
      shortLocationName("Mocha House - Dearborn Heights", "Mocha House"),
    ).toBe("Dearborn Heights");
    expect(shortLocationName("Mocha House – Ann Arbor", "Mocha House")).toBe(
      "Ann Arbor",
    );
  });
  it("leaves other names alone", () => {
    expect(shortLocationName("S0D2E opt-a", "Mocha House")).toBe("S0D2E opt-a");
    expect(shortLocationName("Mocha House", "Mocha House")).toBe("Mocha House");
    expect(shortLocationName("Mocha House - ", "Mocha House")).toBe(
      "Mocha House - ",
    );
  });
});
