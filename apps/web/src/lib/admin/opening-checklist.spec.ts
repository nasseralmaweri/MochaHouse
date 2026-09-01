import {
  buildOpeningChecklistViewModel,
  formatChecklistProgress,
  resolveOpeningChecklistPage,
} from "./opening-checklist";
import type { OpeningChecklistResponse } from "@mocha-house/contracts";

const LOCATION = {
  id: "loc-a",
  name: "Mocha House - Dearborn Heights",
  slug: "dearborn-heights",
  isDigitalOrderingEnabled: true,
};

function checklist(
  overrides: Partial<OpeningChecklistResponse> = {},
): OpeningChecklistResponse {
  return {
    locationId: "loc-a",
    locationName: "Mocha House - Dearborn Heights",
    businessDate: "2026-08-31",
    title: "Opening Checklist",
    progress: { completed: 1, total: 3, isComplete: false },
    sections: [
      {
        name: "Building & Security",
        items: [
          {
            id: "i1",
            label: "Unlock employee entrance and disarm security alarm.",
            completed: true,
            completedBy: { name: "Sarah" },
            completedAt: "2026-08-31T11:00:00.000Z",
          },
          {
            id: "i2",
            label: "Once inside, ensure entrance door is locked.",
            completed: false,
            completedBy: null,
            completedAt: null,
          },
        ],
      },
      {
        name: "Equipment",
        items: [
          {
            id: "i3",
            label: "Turn on espresso machine and allow warm-up.",
            completed: false,
            completedBy: null,
            completedAt: null,
          },
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
        capabilities: {
          "operations.view": { corporate: true, locationIds: [] },
        },
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
        capabilities: {
          "operations.view": { corporate: true, locationIds: [] },
        },
      }),
    ).toEqual({ kind: "pick-location" });
  });

  it("concrete location, holds operations.tasks.complete here → ready + canComplete", () => {
    expect(
      resolveOpeningChecklistPage({
        locationContext: { kind: "location", location: LOCATION },
        capabilities: {
          "operations.view": { corporate: false, locationIds: ["loc-a"] },
          "operations.tasks.complete": {
            corporate: false,
            locationIds: ["loc-a"],
          },
        },
      }),
    ).toEqual({
      kind: "ready",
      locationId: "loc-a",
      locationName: "Mocha House - Dearborn Heights",
      canComplete: true,
    });
  });

  it("concrete location, only operations.view → ready but read-only (canComplete false)", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
      },
    });
    expect(state).toMatchObject({ kind: "ready", canComplete: false });
  });

  it("operations.tasks.complete held only at another location → canComplete false here", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: false, locationIds: ["loc-a"] },
        "operations.tasks.complete": {
          corporate: false,
          locationIds: ["loc-b"],
        },
      },
    });
    expect(state).toMatchObject({ kind: "ready", canComplete: false });
  });

  it("corporate operations.tasks.complete covers this location", () => {
    const state = resolveOpeningChecklistPage({
      locationContext: { kind: "location", location: LOCATION },
      capabilities: {
        "operations.view": { corporate: true, locationIds: [] },
        "operations.tasks.complete": { corporate: true, locationIds: [] },
      },
    });
    expect(state).toMatchObject({ kind: "ready", canComplete: true });
  });
});

describe("formatChecklistProgress", () => {
  it("renders 'X of Y complete' — no percentage or score", () => {
    expect(
      formatChecklistProgress({ completed: 12, total: 23, isComplete: false }),
    ).toBe("12 of 23 complete");
    expect(
      formatChecklistProgress({ completed: 23, total: 23, isComplete: true }),
    ).toBe("23 of 23 complete");
  });
});

describe("buildOpeningChecklistViewModel", () => {
  it("preserves the API's section grouping and order, adding nothing", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), {
      canComplete: true,
    });
    expect(vm.sections.map((s) => s.name)).toEqual([
      "Building & Security",
      "Equipment",
    ]);
    expect(vm.sections.flatMap((s) => s.items.map((i) => i.id))).toEqual([
      "i1",
      "i2",
      "i3",
    ]);
    expect(vm.title).toBe("Opening Checklist");
    expect(vm.businessDate).toBe("2026-08-31");
    expect(vm.progressLabel).toBe("1 of 3 complete");
  });

  it("shows Complete on incomplete items and Undo on complete items for an operator", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), {
      canComplete: true,
    });
    const items = vm.sections.flatMap((s) => s.items);
    const done = items.find((i) => i.id === "i1")!;
    const todo = items.find((i) => i.id === "i2")!;

    expect(done).toMatchObject({
      completed: true,
      completedByName: "Sarah",
      showComplete: false,
      showUndo: true,
    });
    expect(todo).toMatchObject({
      completed: false,
      completedByName: null,
      showComplete: true,
      showUndo: false,
    });
    expect(vm.readOnly).toBe(false);
  });

  it("a read-only viewer gets no operable controls", () => {
    const vm = buildOpeningChecklistViewModel(checklist(), {
      canComplete: false,
    });
    expect(vm.readOnly).toBe(true);
    for (const item of vm.sections.flatMap((s) => s.items)) {
      expect(item.showComplete).toBe(false);
      expect(item.showUndo).toBe(false);
    }
    // ...but completion state is still visible.
    expect(
      vm.sections.flatMap((s) => s.items).find((i) => i.id === "i1")
        ?.completedByName,
    ).toBe("Sarah");
  });

  it("surfaces the complete state when every item is done", () => {
    const vm = buildOpeningChecklistViewModel(
      checklist({
        progress: { completed: 3, total: 3, isComplete: true },
        sections: [
          {
            name: "Building & Security",
            items: [
              {
                id: "i1",
                label: "a",
                completed: true,
                completedBy: { name: "Sarah" },
                completedAt: "2026-08-31T11:00:00.000Z",
              },
            ],
          },
        ],
      }),
      { canComplete: true },
    );
    expect(vm.isComplete).toBe(true);
    expect(vm.progressLabel).toBe("3 of 3 complete");
  });
});
