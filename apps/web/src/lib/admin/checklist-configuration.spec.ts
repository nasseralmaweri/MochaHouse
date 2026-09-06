import type { OpeningChecklistTemplateConfigResponse } from "@mocha-house/contracts";
import {
  CHECKLIST_CONFIG_EFFECT_NOTICE,
  buildChecklistTemplateViewModel,
  canonicalSectionName,
  matchesExistingSection,
  nextChecklistConfigLoadState,
  validateChecklistItemLabel,
  validateChecklistSectionName,
} from "./checklist-configuration";

function template(): OpeningChecklistTemplateConfigResponse {
  return {
    title: "Opening Checklist",
    sections: [
      {
        name: "Building & Security",
        canMoveUp: false,
        canMoveDown: true,
        items: [
          {
            id: "a1",
            label: "Disarm the alarm.",
            isActive: true,
            canMoveUp: false,
            canMoveDown: true,
          },
          {
            id: "a2",
            label: "Lock the entrance behind you.",
            isActive: false,
            canMoveUp: true,
            canMoveDown: false,
          },
        ],
      },
      {
        name: "Equipment",
        canMoveUp: true,
        canMoveDown: false,
        items: [
          {
            id: "b1",
            label: "Warm up the espresso machine.",
            isActive: true,
            canMoveUp: false,
            canMoveDown: false,
          },
        ],
      },
    ],
  };
}

describe("checklist configuration view-model", () => {
  it("keeps the API's grouping, order and move affordances", () => {
    const vm = buildChecklistTemplateViewModel(template());
    expect(vm.title).toBe("Opening Checklist");
    expect(vm.sections.map((s) => s.name)).toEqual([
      "Building & Security",
      "Equipment",
    ]);
    expect(vm.sections[0].items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(vm.sections[0].canMoveUp).toBe(false);
    expect(vm.sections[0].items[0].canMoveDown).toBe(true);
    expect(vm.sections[1].items[0].canMoveUp).toBe(false);
  });

  it("is checklist-agnostic — the title passes straight through (Closing too)", () => {
    const vm = buildChecklistTemplateViewModel({
      ...template(),
      title: "Closing Checklist",
    });
    expect(vm.title).toBe("Closing Checklist");
  });

  it("counts active / inactive items and lists section names for the add picker", () => {
    const vm = buildChecklistTemplateViewModel(template());
    expect(vm.totalItems).toBe(3);
    expect(vm.activeItems).toBe(2);
    expect(vm.inactiveItems).toBe(1);
    expect(vm.sectionNames).toEqual(["Building & Security", "Equipment"]);
  });

  it("the effect notice is instance-based, not 'tomorrow'", () => {
    expect(CHECKLIST_CONFIG_EFFECT_NOTICE).toContain(
      "the next time a location creates this checklist",
    );
    expect(CHECKLIST_CONFIG_EFFECT_NOTICE).toContain(
      "already created are not changed",
    );
    expect(CHECKLIST_CONFIG_EFFECT_NOTICE.toLowerCase()).not.toContain(
      "tomorrow",
    );
  });
});

describe("nextChecklistConfigLoadState", () => {
  it("maps every failed load to a definite state", () => {
    expect(nextChecklistConfigLoadState("success")).toBe("ok");
    expect(nextChecklistConfigLoadState("forbidden")).toBe("forbidden");
    expect(nextChecklistConfigLoadState("not-found")).toBe("error");
    expect(nextChecklistConfigLoadState("invalid")).toBe("error");
    expect(nextChecklistConfigLoadState("error")).toBe("error");
  });
});

describe("section-name matching (mirrors the server)", () => {
  it("canonicalises case and whitespace", () => {
    expect(canonicalSectionName("  Equipment ")).toBe("equipment");
    expect(canonicalSectionName("CASH  &   POS")).toBe("cash & pos");
  });

  it("finds an existing section ignoring case/whitespace", () => {
    const t = template();
    expect(matchesExistingSection(t, "  equipment")).toBe("Equipment");
    expect(matchesExistingSection(t, "Team Huddle")).toBeNull();
  });
});

describe("field validation", () => {
  it("rejects blank / over-long item wording", () => {
    expect(validateChecklistItemLabel("   ")).toEqual({
      ok: false,
      error: "Enter the wording for this item.",
    });
    expect(validateChecklistItemLabel("x".repeat(501)).ok).toBe(false);
    expect(validateChecklistItemLabel("  Brew coffee.  ")).toEqual({
      ok: true,
      value: "Brew coffee.",
    });
  });

  it("rejects blank / over-long section names", () => {
    expect(validateChecklistSectionName("").ok).toBe(false);
    expect(validateChecklistSectionName("y".repeat(121)).ok).toBe(false);
    expect(validateChecklistSectionName("  Team Huddle ")).toEqual({
      ok: true,
      value: "Team Huddle",
    });
  });
});
