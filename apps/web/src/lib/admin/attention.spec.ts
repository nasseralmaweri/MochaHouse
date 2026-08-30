import type { LocationSummary } from "@mocha-house/contracts";
import { digitalOrderingAttentionItems } from "./attention";
import type { AdminCapabilities } from "./capabilities";

const loc = (
  id: string,
  name: string,
  isDigitalOrderingEnabled: boolean,
): LocationSummary => ({ id, name, slug: id, isDigitalOrderingEnabled });

const A = loc("loc-a", "Alpha", false); // disabled
const B = loc("loc-b", "Bravo", false); // disabled
const C = loc("loc-c", "Charlie", true); // enabled

describe("digitalOrderingAttentionItems", () => {
  it("does NOT leak Location B when the permission is only effective at Location A", () => {
    const capabilities: AdminCapabilities = {
      "locations.manage_digital_ordering": {
        corporate: false,
        locationIds: ["loc-a"],
      },
    };
    const items = digitalOrderingAttentionItems([A, B], capabilities);
    expect(items.map((i) => i.id)).toEqual(["digital-ordering-loc-a"]);
    expect(items[0].description).toContain("Alpha");
  });

  it("links each item to that location's detail page (Milestone 5D-2)", () => {
    const capabilities: AdminCapabilities = {
      "locations.manage_digital_ordering": { corporate: true, locationIds: [] },
    };
    const items = digitalOrderingAttentionItems([A], capabilities);
    expect(items[0].href).toBe("/admin/locations/loc-a");
  });

  it("shows nothing when the user lacks locations.manage_digital_ordering entirely", () => {
    const capabilities: AdminCapabilities = {
      "orders.view": { corporate: true, locationIds: [] },
    };
    expect(digitalOrderingAttentionItems([A, B], capabilities)).toEqual([]);
  });

  it("a CORPORATE grant surfaces every disabled visible location", () => {
    const capabilities: AdminCapabilities = {
      "locations.manage_digital_ordering": { corporate: true, locationIds: [] },
    };
    const items = digitalOrderingAttentionItems([A, B, C], capabilities);
    expect(items.map((i) => i.id).sort()).toEqual([
      "digital-ordering-loc-a",
      "digital-ordering-loc-b",
    ]);
  });

  it("enabled locations are never surfaced", () => {
    const capabilities: AdminCapabilities = {
      "locations.manage_digital_ordering": { corporate: true, locationIds: [] },
    };
    expect(digitalOrderingAttentionItems([C], capabilities)).toEqual([]);
  });

  it("empty when there are no visible locations", () => {
    expect(digitalOrderingAttentionItems([], {})).toEqual([]);
  });
});
