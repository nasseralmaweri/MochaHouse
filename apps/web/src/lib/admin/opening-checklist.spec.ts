import {
  buildOpeningChecklistViewModel,
  formatChecklistProgress,
  nextChecklistLoadState,
  resolveOpeningChecklistPage,
} from "./opening-checklist";
import type {
  OpeningChecklistItemView,
  OpeningChecklistResponse,
} from "@mocha-house/contracts";

const LOCATION = {
  id: "loc-a",
  name: "Mocha House - Dearborn Heights",
  slug: "dearborn-heights",
  isDigitalOrderingEnabled: true,
};

function item(overrides: Partial<OpeningChecklistItemView>): OpeningChecklistItemView {
  return {
    id: "i0",
    label: "An item",
    status: "open",
    resolved: false,
    completed: false,
    completedBy: null,
    completedAt: null,
    exception: null,
    ...overrides,
  };
}

function checklist(
  overrides: Partial<OpeningChecklistResponse> = {},
): OpeningChecklistResponse {
  return {
    locationId: "loc-a",
    locationName: "Mocha House - Dearborn Heights",
    businessDate: "2026-08-31",
    title: "Opening Checklist",
    progress: { completed: 1, resolved: 1, total: 3, isComplete: false },
    sections: [
      {
        name: "Building & Security",
        items: [
          item({
            id: "i1",
            label: "Unlock employee entrance and disarm security alarm.",
            status: "completed",
            resolved: true,
            completed: true,
            completedBy: { name: "Sarah" },
            completedAt: "2026-08-31T11:00:00.000Z",
          }),
          item({ id: "i2", label: "Once inside, ensure entrance door is locked." }),
        ],
      },
      {
        name: "Equipment",
        items: [
          item({ id: "i3", label: "Turn on espresso machine and allow warm-up." }),
        ],
      },
    ],
    ...overrides,
  };
}

describe("resolveOpeningChecklistPage", () => {
  it("forbidden context → forbidden-location", () => {
    expect(
      resolveOpeningChecklistPage({
        locationContext: { kind: "forbidden", requestedId: "loc-x" },
        capabilities: { "operations.view": { corporate: true, locationIds: [] } },
      }),
    ).toEqual({ kind: "forbidden-location" });
  });

  it("no authorized location → no-location", () => {
    expect(
      resolveOpeningChecklistPage({
        locationContext: { kind: "none" },
        capabilities: {},
      }),
    ).toEqual({ kind: "no-location" });
  });

  it("corporate viewer with no location chosen → pick-location", () => {
    expect(
      resolveOpeningChecklistPage({
        locationContext: { kind: "corporate" },
        capabilities: { "operations.view": { corporate: true, locationIds: [] } },
      }),
    ).toEqual({ kind: "pick-location" });
  });

  it("concrete location, holds tasks.complete + exceptions.manage here → ready with both", () => {
    expect(
      resolveOpeningChecklistPage({
        locationContext: { kind: "location", location: LOCATION },
        capabilities: {
          "operations.view": { corporate: false, locationIds: ["loc-a"] },
          "operations.tasks.complete": { corporate: false, locationIds: ["loc-a"] },
          "operations.exceptions.manage": { corporate: false, locationIds: ["loc-a"] },
        },
      }),
    ).toEqual({
      kind: "ready",
      locationId: "loc-a",
      locationName: "Mocha House - Dearborn Heights",
      canComplete: true,
      canLogExceptions: true,
    });
  });

  it("only operations.view → ready but read-only", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(state).toMatchObject({
      kind: "ready",
      canComplete: false,
      canLogExceptions: false,
    });
  });

  it("tasks.complete without exceptions.manage → canComplete true, canLogExceptions false", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "operations.tasks.complete": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(state).toMatchObject({ canComplete: true, canLogExceptions: false });
  });

  it("exceptions.manage held only at another location → canLogExceptions false here", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "operations.exceptions.manage": { corporate: false, locationIds: ["loc-b"] },
      },
    });
    expect(state).toMatchObject({ canLogExceptions: false });
  });

  it("corporate grants cover this location", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: true, locationIds: [] },
        "operations.tasks.complete": { corporate: true, locationIds: [] },
        "operations.exceptions.manage": { corporate: true, locationIds: [] },
      },
    });
    expect(state).toMatchObject({ canComplete: true, canLogExceptions: true });
  });
});

describe("formatChecklistProgress", () => {
  it("renders 'resolved of total complete' — no percentage or score", () => {
    expect(
      formatChecklistProgress({
        completed: 10,
        resolved: 12,
        total: 23,
        isComplete: false,
      }),
    ).toBe("12 of 23 complete");
  });

  it("an exception counts toward the resolved total shown", () => {
    // 22 completed normally + 1 exception = 23 resolved of 23.
    expect(
      formatChecklistProgress({
        completed: 22,
        resolved: 23,
        total: 23,
        isComplete: true,
      }),
    ).toBe("23 of 23 complete");
  });
});

describe("nextChecklistLoadState", () => {
  it("success / invalid keep the page ('ok')", () => {
    expect(nextChecklistLoadState("success")).toBe("ok");
    expect(nextChecklistLoadState("invalid")).toBe("ok");
  });
  it("forbidden → forbidden", () => {
    expect(nextChecklistLoadState("forbidden")).toBe("forbidden");
  });
  it("a failed initial load ('error' / 'not-found') reaches 'error'", () => {
    expect(nextChecklistLoadState("error")).toBe("error");
    expect(nextChecklistLoadState("not-found")).toBe("error");
  });
});

describe("buildOpeningChecklistViewModel", () => {
  const both = { canComplete: true, canLogExceptions: true };

  it("preserves the API's section grouping and order, adding nothing", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), both);
    expect(vm.sections.map((s) => s.name)).toEqual([
      "Building & Security",
      "Equipment",
    ]);
    expect(vm.sections.flatMap((s) => s.items.map((i) => i.id))).toEqual([
      "i1",
      "i2",
      "i3",
    ]);
    expect(vm.progressLabel).toBe("1 of 3 complete");
  });

  it("Complete on open items, Undo on normally completed items", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), both);
    const items = vm.sections.flatMap((s) => s.items);
    expect(items.find((i) => i.id === "i1")).toMatchObject({
      status: "completed",
      completed: true,
      completedByName: "Sarah",
      showComplete: false,
      showUndo: true,
      showLogException: false,
      showClearException: false,
    });
    expect(items.find((i) => i.id === "i2")).toMatchObject({
      status: "open",
      showComplete: true,
      showUndo: false,
      showLogException: true,
      showClearException: false,
    });
  });

  it("an exception-resolved item shows its reason and offers only Clear Exception", () => {
    const vm = buildOpeningChecklistViewModel(
      checklist({
        progress: { completed: 1, resolved: 2, total: 3, isComplete: false },
        sections: [
          {
            name: "Equipment",
            items: [
              item({
                id: "x1",
                label: "Turn on espresso machine.",
                status: "exception",
                resolved: true,
                completed: false,
                exception: {
                  reason: "Machine is out for repair",
                  by: { name: "Dana" },
                  at: "2026-08-31T11:30:00.000Z",
                },
              }),
            ],
          },
        ],
      }),
      both,
    );
    const it0 = vm.sections[0].items[0];
    expect(it0.status).toBe("exception");
    expect(it0.completed).toBe(false);
    expect(it0.exception).toEqual({
      reason: "Machine is out for repair",
      byName: "Dana",
      at: "2026-08-31T11:30:00.000Z",
    });
    expect(it0).toMatchObject({
      showComplete: false,
      showUndo: false,
      showLogException: false,
      showClearException: true,
    });
  });

  it("a viewer with only tasks.complete cannot log exceptions", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), {
      canComplete: true,
      canLogExceptions: false,
    });
    for (const i of vm.sections.flatMap((s) => s.items)) {
      expect(i.showLogException).toBe(false);
      expect(i.showClearException).toBe(false);
    }
    expect(vm.readOnly).toBe(false);
  });

  it("a read-only viewer gets no operable controls but still sees state", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), {
      canComplete: false,
      canLogExceptions: false,
    });
    expect(vm.readOnly).toBe(true);
    for (const i of vm.sections.flatMap((s) => s.items)) {
      expect(i.showComplete).toBe(false);
      expect(i.showUndo).toBe(false);
      expect(i.showLogException).toBe(false);
      expect(i.showClearException).toBe(false);
    }
    expect(
      vm.sections.flatMap((s) => s.items).find((i) => i.id === "i1")
        ?.completedByName,
    ).toBe("Sarah");
  });

  it("surfaces the complete state when every item is resolved", () => {
    const vm = buildOpeningChecklistViewModel(
      checklist({
        progress: { completed: 1, resolved: 1, total: 1, isComplete: true },
        sections: [
          {
            name: "Building & Security",
            items: [
              item({
                id: "i1",
                label: "a",
                status: "completed",
                resolved: true,
                completed: true,
                completedBy: { name: "Sarah" },
                completedAt: "2026-08-31T11:00:00.000Z",
              }),
            ],
          },
        ],
      }),
      both,
    );
    expect(vm.isComplete).toBe(true);
    expect(vm.progressLabel).toBe("1 of 1 complete");
  });
});
