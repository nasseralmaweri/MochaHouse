import type {
  AdminGettingStartedResponse,
  GettingStartedStepKey,
} from "@mocha-house/contracts";
import {
  gettingStartedProgressLabel,
  gettingStartedSteps,
  nextGettingStartedStep,
  orderingNotReadyMessage,
  setupCompleteBadge,
  setupCompleteNote,
} from "./getting-started";

const KEYS: GettingStartedStepKey[] = [
  "business",
  "billing",
  "location",
  "profile",
  "hours",
  "menu",
  "ordering",
];

function checklist(
  done: GettingStartedStepKey[],
  extra: Partial<AdminGettingStartedResponse> = {},
): AdminGettingStartedResponse {
  return {
    steps: KEYS.map((key) => ({ key, done: done.includes(key) })),
    completedCount: done.length,
    totalCount: KEYS.length,
    setupComplete: done.length === KEYS.length,
    locationId: null,
    menuId: null,
    storefrontLive: false,
    ...extra,
  };
}

describe("getting-started checklist presentation (SC4d)", () => {
  it("shows every step in order with one action per open step", () => {
    const steps = gettingStartedSteps(checklist(["business"]));
    expect(steps.map((step) => step.key)).toEqual(KEYS);
    expect(steps[0]).toMatchObject({ done: true, action: null });
    expect(steps[1].action).toEqual({
      label: "Set up payment",
      href: "/admin/billing",
    });
    expect(steps[2].action).toEqual({
      label: "Add location",
      href: "/admin/locations/new",
    });
    // Location steps need a location first: no dead links.
    expect(steps.slice(3).map((step) => step.action)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("points location steps at the business's location and its menu", () => {
    const withLocation = gettingStartedSteps(
      checklist(["business", "location"], { locationId: "loc 1" }),
    );
    const byKey = Object.fromEntries(
      withLocation.map((step) => [step.key, step.action?.href ?? null]),
    );
    expect(byKey).toMatchObject({
      profile: "/admin/locations/loc%201/profile",
      hours: "/admin/locations/loc%201/hours",
      menu: "/admin/locations/loc%201/choose-menu",
      ordering: "/admin/locations/loc%201#online-ordering",
    });
    const withMenu = gettingStartedSteps(
      checklist(["business", "location"], { locationId: "l1", menuId: "m1" }),
    );
    expect(withMenu.find((step) => step.key === "menu")?.action).toEqual({
      label: "Add products",
      href: "/admin/menu/menus/m1",
    });
  });

  it("names the next step and the progress", () => {
    const list = checklist(["business", "billing", "location"], {
      locationId: "l1",
    });
    expect(nextGettingStartedStep(list)?.key).toBe("profile");
    expect(gettingStartedProgressLabel(list)).toBe("3 of 7 steps done");
    expect(nextGettingStartedStep(checklist(KEYS))).toBeNull();
  });

  it("never reads 'setup complete' as publicly live", () => {
    // Online ordering may be on, but customers can't reach the business.
    expect(setupCompleteNote(false)).toMatch(/isn't publicly live yet/);
    expect(setupCompleteNote(false)).toMatch(/customers can't reach/);
    expect(setupCompleteBadge(false)).toBe("Not live yet");
    // Only when this deployment's storefront serves the business.
    expect(setupCompleteBadge(true)).toBe("Storefront live");
  });

  it("lists the open steps that block online ordering", () => {
    expect(orderingNotReadyMessage(["billing", "hours"])).toBe(
      "Before you can turn on online ordering, finish: start your subscription or trial; set your opening hours.",
    );
    expect(orderingNotReadyMessage([])).toMatch(/Finish setting up/);
  });
});
