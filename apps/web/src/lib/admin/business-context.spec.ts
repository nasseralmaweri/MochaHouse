import { resolveActiveBusiness } from "./business-context";

const mocha = { id: "t-mocha", name: "Mocha House", slug: "mocha-house" };
const other = { id: "t-other", name: "Northside Cafe", slug: "northside" };

describe("resolveActiveBusiness", () => {
  it("selects the only business implicitly", () => {
    expect(resolveActiveBusiness([mocha], null)).toEqual({
      kind: "active",
      business: mocha,
    });
  });

  it("honours a cookie that names an authorized business", () => {
    expect(resolveActiveBusiness([mocha, other], "t-other")).toEqual({
      kind: "active",
      business: other,
    });
  });

  it("ignores a cookie naming a business the user cannot enter", () => {
    expect(resolveActiveBusiness([mocha], "t-forged")).toEqual({
      kind: "active",
      business: mocha,
    });
  });

  it("requires a choice when several are enterable and none is valid", () => {
    expect(resolveActiveBusiness([mocha, other], "t-forged")).toEqual({
      kind: "selection-required",
      businesses: [mocha, other],
    });
    expect(resolveActiveBusiness([mocha, other], null).kind).toBe(
      "selection-required",
    );
  });

  it("reports none when no business is enterable, whatever the cookie says", () => {
    expect(resolveActiveBusiness([], "t-mocha")).toEqual({ kind: "none" });
  });
});
