import {
  REGISTRY_STATE_COPY,
  SUSPENSION_REASON_LABELS,
  TENANT_PAGE_SIZE,
  emptyListKind,
  formatRegistryDate,
  isTenantId,
  pageWindow,
  parsePage,
  parseTenantListFilters,
  registryStateFromStatus,
  tenantListHref,
  tenantListQuery,
} from "./tenant-registry";

// SC1c — the tenant registry screens' logic: the query string is read with
// the API's own bounds, links and paging are exact, and every API answer
// maps to a screen state that never shows a server detail.

describe("reading the Tenants page query string", () => {
  it("defaults to every business, page 1", () => {
    expect(parseTenantListFilters({})).toEqual({
      filters: { q: "", status: "", page: 1 },
      searchError: null,
    });
  });

  it("keeps a valid search and status, trimmed", () => {
    expect(
      parseTenantListFilters({ q: "  Mocha   House ", status: "SUSPENDED", page: "3" }),
    ).toEqual({
      filters: { q: "Mocha House", status: "SUSPENDED", page: 3 },
      searchError: null,
    });
  });

  it("an unknown status or bad page falls back to the default rather than an API error", () => {
    const { filters } = parseTenantListFilters({ status: "DELETED", page: "-2" });
    expect(filters).toEqual({ q: "", status: "", page: 1 });
    expect(parsePage("0")).toBe(1);
    expect(parsePage("1e3")).toBe(1);
    expect(parsePage(["2", "3"])).toBe(1);
    expect(parsePage("99999")).toBe(1000);
  });

  it("a search the API would refuse is a message, not a request", () => {
    expect(parseTenantListFilters({ q: "100%" }).searchError).toMatch(/letters, numbers/);
    expect(parseTenantListFilters({ q: "<b>" }).searchError).not.toBeNull();
    expect(parseTenantListFilters({ q: "x".repeat(81) }).searchError).toMatch(/80/);
    expect(parseTenantListFilters({ q: "Café O'Brien & Co." }).searchError).toBeNull();
  });
});

describe("registry links and paging", () => {
  it("asks the API for only what is set, with a fixed page size", () => {
    expect(tenantListQuery({ q: "", status: "", page: 1 })).toBe(
      `pageSize=${TENANT_PAGE_SIZE}`,
    );
    expect(tenantListQuery({ q: "Mocha House", status: "ACTIVE", page: 2 })).toBe(
      `q=Mocha+House&status=ACTIVE&page=2&pageSize=${TENANT_PAGE_SIZE}`,
    );
  });

  it("links keep the filters, and page 1 is the bare list", () => {
    expect(tenantListHref({})).toBe("/platform/tenants");
    expect(tenantListHref({ q: "a&b", status: "SUSPENDED", page: 1 })).toBe(
      "/platform/tenants?q=a%26b&status=SUSPENDED",
    );
    expect(tenantListHref({ page: 4 })).toBe("/platform/tenants?page=4");
  });

  it("computes the visible range and the previous/next links", () => {
    expect(pageWindow(1, 20, 45)).toEqual({
      page: 1,
      totalPages: 3,
      from: 1,
      to: 20,
      total: 45,
      hasPrevious: false,
      hasNext: true,
    });
    expect(pageWindow(3, 20, 45)).toMatchObject({ from: 41, to: 45, hasNext: false });
    expect(pageWindow(1, 20, 0)).toMatchObject({
      totalPages: 1,
      from: 0,
      to: 0,
      hasPrevious: false,
      hasNext: false,
    });
    // Past the last page (a hand-edited URL): nothing shown, way back offered.
    expect(pageWindow(9, 20, 45)).toMatchObject({ to: 45, hasPrevious: true, hasNext: false });
  });
});

describe("screen states", () => {
  it("maps the API answer to a state, failing closed", () => {
    expect(registryStateFromStatus(200)).toBe("ok");
    expect(registryStateFromStatus(401)).toBe("session-ended");
    expect(registryStateFromStatus(403)).toBe("access-denied");
    expect(registryStateFromStatus(404)).toBe("not-found");
    expect(registryStateFromStatus(400)).toBe("invalid");
    for (const status of [500, 502, 503, 429, null]) {
      expect(registryStateFromStatus(status)).toBe("unavailable");
    }
  });

  it("every error, denied and loading-failure state has plain copy with no server detail", () => {
    for (const copy of Object.values(REGISTRY_STATE_COPY)) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(`${copy.title} ${copy.body}`).not.toMatch(
        /exception|stack|prisma|cognito|token|sql|http|\b5\d\d\b/i,
      );
    }
    expect(REGISTRY_STATE_COPY["access-denied"].title).toBe("Access denied");
  });

  it("chooses the right empty state", () => {
    expect(emptyListKind(true, 0)).toBe("no-matches");
    expect(emptyListKind(false, 0)).toBe("no-businesses");
    expect(emptyListKind(false, 12)).toBe("past-last-page");
  });
});

describe("labels", () => {
  it("formats registry dates in UTC and survives a bad value", () => {
    expect(formatRegistryDate("2026-10-15T23:30:00.000Z")).toBe("15 Oct 2026");
    expect(formatRegistryDate("not a date")).toBe("—");
  });

  it("labels every suspension reason", () => {
    expect(Object.keys(SUSPENSION_REASON_LABELS).sort()).toEqual([
      "BILLING",
      "REQUESTED",
      "SECURITY",
    ]);
  });

  it("only a lowercase uuid is treated as a tenant id", () => {
    expect(isTenantId("01a0db02-f800-7000-8000-7e570000000b")).toBe(true);
    expect(isTenantId("../admin")).toBe(false);
    expect(isTenantId("mocha-house")).toBe(false);
  });
});
