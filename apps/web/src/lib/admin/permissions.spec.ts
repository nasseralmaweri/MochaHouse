import { can, canAny } from "./permissions";

describe("can / canAny", () => {
  it("can() checks a single key", () => {
    expect(can(["orders.view"], "orders.view")).toBe(true);
    expect(can(["orders.view"], "orders.manage_status")).toBe(false);
    expect(can([], "orders.view")).toBe(false);
  });

  it("canAny() is true when the user holds at least one of the keys", () => {
    expect(canAny(["orders.view"], ["orders.view", "orders.manage_status"])).toBe(
      true,
    );
    expect(
      canAny(["catalog.products.edit"], ["orders.view", "orders.manage_status"]),
    ).toBe(false);
  });
});
