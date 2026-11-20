import { orderTaxLines, taxLineLabel } from "./tax";
import { taxPageNote } from "../admin/tax";

// V1 Sales Tax PR 2 — how tax reads to customers and staff.
describe("sales tax display", () => {
  it("labels each tax with its exact rate", () => {
    expect(taxLineLabel({ name: "Michigan sales tax", ratePercent: "6" })).toBe(
      "Michigan sales tax (6%)",
    );
    expect(taxLineLabel({ name: "City", ratePercent: "1.25" })).toBe(
      "City (1.25%)",
    );
  });

  it("shows one line per tax from the order's snapshot", () => {
    expect(
      orderTaxLines(73, {
        taxMinorUnits: 73,
        taxVersion: 2,
        lineTaxMinorUnits: [73],
        components: [
          {
            name: "State",
            jurisdiction: "STATE",
            ratePercent: "6",
            taxableMinorUnits: 1000,
            taxMinorUnits: 60,
          },
          {
            name: "City",
            jurisdiction: "CITY",
            ratePercent: "1.25",
            taxableMinorUnits: 1000,
            taxMinorUnits: 13,
          },
        ],
      }),
    ).toEqual([
      { label: "State (6%)", amountMinorUnits: 60 },
      { label: "City (1.25%)", amountMinorUnits: 13 },
    ]);
  });

  it("shows a zero-tax location as Sales tax $0, and nothing for an order from before tax", () => {
    expect(
      orderTaxLines(0, {
        taxMinorUnits: 0,
        taxVersion: 1,
        lineTaxMinorUnits: [0],
        components: [],
      }),
    ).toEqual([{ label: "Sales tax", amountMinorUnits: 0 }]);
    expect(orderTaxLines(0, null)).toEqual([]);
  });

  it("explains on the Admin page whether checkout charges tax yet", () => {
    expect(taxPageNote(false)).toMatch(/not added to orders yet/);
    expect(taxPageNote(true)).toMatch(/Checkout adds/);
  });
});
