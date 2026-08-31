import {
  activityTypeLabel,
  AUDIT_ACTIVITY_OPTIONS,
  buildAuditQuery,
  checkAuditDateRange,
  EMPTY_AUDIT_FILTERS,
  hasActiveAuditFilters,
  isAuditActivityType,
  normalizeAuditFilters,
  type AuditFilters,
} from "./audit-log";

describe("audit activity filter vocabulary", () => {
  it("offers exactly the three business activity types with plain labels (65)", () => {
    expect(AUDIT_ACTIVITY_OPTIONS).toEqual([
      {
        value: "admin_access_status_changed",
        label: "Admin access status changed",
      },
      { value: "admin_access_granted", label: "Admin access granted" },
      { value: "admin_access_removed", label: "Admin access removed" },
    ]);
  });

  it("isAuditActivityType accepts only the business values", () => {
    expect(isAuditActivityType("admin_access_granted")).toBe(true);
    expect(isAuditActivityType("user.role_assigned")).toBe(false);
    expect(isAuditActivityType("")).toBe(false);
  });

  it("activityTypeLabel falls back to 'All activity'", () => {
    expect(activityTypeLabel("admin_access_removed")).toBe(
      "Admin access removed",
    );
    expect(activityTypeLabel(null)).toBe("All activity");
    expect(activityTypeLabel("nonsense")).toBe("All activity");
  });
});

describe("normalizeAuditFilters (72)", () => {
  it("drops blank and unknown values", () => {
    expect(
      normalizeAuditFilters({
        type: "  ",
        from: "",
        to: undefined,
        actor: "   ",
      }),
    ).toEqual(EMPTY_AUDIT_FILTERS);
  });

  it("keeps a known activity type and trims text", () => {
    expect(
      normalizeAuditFilters({
        type: "admin_access_granted",
        actor: "  Nasser  ",
        from: "2026-08-01",
      }),
    ).toEqual({
      type: "admin_access_granted",
      from: "2026-08-01",
      to: null,
      actor: "Nasser",
    });
  });

  it("drops an unrecognised activity type instead of erroring", () => {
    expect(normalizeAuditFilters({ type: "user.status_changed" }).type).toBeNull();
  });

  it("takes the first value of a repeated param", () => {
    expect(
      normalizeAuditFilters({ type: ["admin_access_removed", "x"] }).type,
    ).toBe("admin_access_removed");
  });
});

describe("checkAuditDateRange (70)", () => {
  it("accepts an empty range", () => {
    expect(checkAuditDateRange(null, null)).toBeNull();
  });
  it("accepts a valid ordered range", () => {
    expect(checkAuditDateRange("2026-08-01", "2026-08-31")).toBeNull();
    expect(checkAuditDateRange("2026-08-31", "2026-08-31")).toBeNull();
  });
  it("rejects a malformed date", () => {
    expect(checkAuditDateRange("2026-8-1", null)).toMatch(/From date/);
    expect(checkAuditDateRange(null, "yesterday")).toMatch(/To date/);
    expect(checkAuditDateRange(null, "2026-13-40")).toMatch(/To date/);
  });
  it("rejects from after to", () => {
    expect(checkAuditDateRange("2026-09-01", "2026-08-01")).toMatch(
      /on or before/,
    );
  });
});

describe("buildAuditQuery (66,67)", () => {
  const filters: AuditFilters = {
    type: "admin_access_granted",
    from: "2026-08-01",
    to: null,
    actor: "Nasser",
  };

  it("drops empty values", () => {
    expect(buildAuditQuery(EMPTY_AUDIT_FILTERS)).toBe("");
  });

  it("serialises active filters", () => {
    expect(buildAuditQuery(filters)).toBe(
      "?type=admin_access_granted&from=2026-08-01&actor=Nasser",
    );
  });

  it("appends the cursor only when provided (67)", () => {
    expect(buildAuditQuery(filters, "01a0-cursor")).toBe(
      "?type=admin_access_granted&from=2026-08-01&actor=Nasser&cursor=01a0-cursor",
    );
    expect(buildAuditQuery(filters, null)).toBe(
      "?type=admin_access_granted&from=2026-08-01&actor=Nasser",
    );
  });
});

describe("cursor + filter behavior (68,69)", () => {
  const active: AuditFilters = {
    type: "admin_access_status_changed",
    from: null,
    to: null,
    actor: "sarah",
  };

  it("changing a filter drops the cursor (68)", () => {
    // The island navigates with buildAuditQuery(newFilters) and no cursor.
    const next = buildAuditQuery({ ...active, type: "admin_access_removed" });
    expect(next).not.toContain("cursor=");
    expect(next).toContain("type=admin_access_removed");
  });

  it("'Back to newest' removes the cursor but preserves filters (69)", () => {
    const backToNewest = buildAuditQuery(active);
    expect(backToNewest).not.toContain("cursor=");
    expect(backToNewest).toContain("type=admin_access_status_changed");
    expect(backToNewest).toContain("actor=sarah");
  });
});

describe("hasActiveAuditFilters (71)", () => {
  it("is false for the empty filter set", () => {
    expect(hasActiveAuditFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
  });
  it("is true when any filter is set", () => {
    expect(hasActiveAuditFilters({ ...EMPTY_AUDIT_FILTERS, type: "admin_access_granted" })).toBe(true);
    expect(hasActiveAuditFilters({ ...EMPTY_AUDIT_FILTERS, actor: "x" })).toBe(true);
    expect(hasActiveAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: "2026-01-01" })).toBe(true);
  });
});
