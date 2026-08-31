import {
  formatOperationsToday,
  resolveOperationsTodayView,
} from "./operations-today";
import type { AdminCapabilities } from "./capabilities";

const LOCATION = {
  id: "loc-a",
  name: "Mocha House - Dearborn Heights",
  slug: "dearborn-heights",
  isDigitalOrderingEnabled: true,
};

describe("resolveOperationsTodayView", () => {
  it("forbidden context → forbidden-location", () => {
    expect(
      resolveOperationsTodayView({
        locationContext: { kind: "forbidden", requestedId: "loc-x" },
        capabilities: { "operations.view": { corporate: true, locationIds: [] } },
      }),
    ).toEqual({ kind: "forbidden-location" });
  });

  it("no authorized location → no-location", () => {
    expect(
      resolveOperationsTodayView({
        locationContext: { kind: "none" },
        capabilities: {
          "operations.view": { corporate: false, locationIds: [] },
        },
      }),
    ).toEqual({ kind: "no-location" });
  });

  it("corporate viewer with no location chosen → pick-location", () => {
    expect(
      resolveOperationsTodayView({
        locationContext: { kind: "corporate" },
        capabilities: {
          "operations.view": { corporate: true, locationIds: [] },
          "orders.view": { corporate: true, locationIds: [] },
        },
      }),
    ).toEqual({ kind: "pick-location" });
  });

  it("concrete location → ready, with a plain-language heading", () => {
    const state = resolveOperationsTodayView({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "orders.view": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.location.id).toBe("loc-a");
    expect(state.locationHeading).toBe(
      "Today at Mocha House - Dearborn Heights",
    );
  });

  it("shows the order snapshot only when orders.view is effective for THIS location", () => {
    const base = {
      locationContext: { kind: "location", location: LOCATION } as const,
    };

    // operations.view but NO orders.view → page still works, snapshot hidden.
    const withoutOrders = resolveOperationsTodayView({
      ...base,
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(withoutOrders).toMatchObject({
      kind: "ready",
      showOrderSnapshot: false,
    });

    // orders.view held only at another location → still hidden here.
    const ordersElsewhere = resolveOperationsTodayView({
      ...base,
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "orders.view": { corporate: false, locationIds: ["loc-b"] },
      } as AdminCapabilities,
    });
    expect(ordersElsewhere).toMatchObject({ showOrderSnapshot: false });

    // orders.view effective for this location → shown.
    const ordersHere = resolveOperationsTodayView({
      ...base,
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "orders.view": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(ordersHere).toMatchObject({ showOrderSnapshot: true });

    // corporate orders.view covers every location.
    const ordersCorporate = resolveOperationsTodayView({
      ...base,
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "orders.view": { corporate: true, locationIds: [] },
      },
    });
    expect(ordersCorporate).toMatchObject({ showOrderSnapshot: true });
  });
});

describe("formatOperationsToday", () => {
  it("renders a full weekday / day / month / year date (presentation only)", () => {
    // A fixed instant, pinned to a known locale + zone so the assertion is
    // stable regardless of where the test runs.
    const date = new Date("2026-08-31T12:00:00.000Z");
    expect(formatOperationsToday(date, "en-GB", "UTC")).toBe(
      "Monday, 31 August 2026",
    );
  });

  it("carries no persisted or timezone-configured value — it is a pure format of the given instant", () => {
    const a = formatOperationsToday(
      new Date("2026-01-01T12:00:00Z"),
      "en-GB",
      "UTC",
    );
    const b = formatOperationsToday(
      new Date("2026-01-01T12:00:00Z"),
      "en-GB",
      "UTC",
    );
    expect(a).toBe(b);
    expect(a).toBe("Thursday, 1 January 2026");
  });
});
