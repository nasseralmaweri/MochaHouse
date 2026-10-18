import {
  moveItem,
  parsePriceAdjustmentInput,
  parseSelectionInputs,
  priceAdjustmentLabel,
  selectionRuleLabel,
  sharedGroupNotice,
} from "./modifiers";

describe("selectionRuleLabel", () => {
  it("says whether the group is required and how many choices it takes", () => {
    expect(selectionRuleLabel(1, 1)).toBe("Required · choose 1");
    expect(selectionRuleLabel(2, 4)).toBe("Required · choose 2–4");
    expect(selectionRuleLabel(1, null)).toBe("Required · choose at least 1");
    expect(selectionRuleLabel(0, 1)).toBe("Optional · choose up to 1");
    expect(selectionRuleLabel(0, null)).toBe("Optional · choose any number");
  });
});

describe("priceAdjustmentLabel and sharedGroupNotice", () => {
  it("words prices and sharing plainly", () => {
    expect(priceAdjustmentLabel(0)).toBe("No extra charge");
    expect(priceAdjustmentLabel(50)).toBe("+$0.50");
    expect(sharedGroupNotice(0)).toBe("Not on any product yet.");
    expect(sharedGroupNotice(1)).toBe("Used by 1 product. Changes here apply to it.");
    expect(sharedGroupNotice(3)).toBe(
      "Used by 3 products. Changes here apply to all of them.",
    );
  });
});

describe("parsePriceAdjustmentInput", () => {
  it("reads dollars as whole cents, blank as no charge, within $0–$100", () => {
    expect(parsePriceAdjustmentInput("")).toEqual({ ok: true, value: 0 });
    expect(parsePriceAdjustmentInput("0.5")).toEqual({ ok: true, value: 50 });
    expect(parsePriceAdjustmentInput("$1.25")).toEqual({ ok: true, value: 125 });
    expect(parsePriceAdjustmentInput("100")).toEqual({ ok: true, value: 10_000 });
    for (const bad of ["100.01", "-1", "abc", "1.234"]) {
      expect(parsePriceAdjustmentInput(bad).ok).toBe(false);
    }
  });
});

describe("parseSelectionInputs", () => {
  it("matches the API's rules", () => {
    expect(parseSelectionInputs("1", "1", false)).toEqual({
      ok: true,
      value: { minSelections: 1, maxSelections: 1 },
    });
    expect(parseSelectionInputs("0", "", true)).toEqual({
      ok: true,
      value: { minSelections: 0, maxSelections: null },
    });
    expect(parseSelectionInputs("0", "3", false)).toEqual({
      ok: true,
      value: { minSelections: 0, maxSelections: 3 },
    });
    for (const [min, max] of [
      ["", "1"],
      ["-1", "1"],
      ["21", "21"],
      ["1.5", "2"],
      ["2", "1"],
      ["0", "0"],
      ["0", "21"],
      ["0", ""],
    ]) {
      expect(parseSelectionInputs(min, max, false).ok).toBe(false);
    }
  });
});

describe("moveItem", () => {
  it("moves one place, and never past either end", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
