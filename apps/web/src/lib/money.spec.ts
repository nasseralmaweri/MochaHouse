import { centsToDollarInput, parseDollarInput } from "./money";

describe("centsToDollarInput", () => {
  it("formats cents as a two-decimal dollar string", () => {
    expect(centsToDollarInput(350)).toBe("3.50");
    expect(centsToDollarInput(400)).toBe("4.00");
    expect(centsToDollarInput(0)).toBe("0.00");
    expect(centsToDollarInput(1299)).toBe("12.99");
  });

  it("returns an empty string for null (no standard price)", () => {
    expect(centsToDollarInput(null)).toBe("");
  });
});

describe("parseDollarInput", () => {
  it("parses whole and fractional dollar amounts to integer cents", () => {
    expect(parseDollarInput("3.50")).toEqual({ ok: true, cents: 350 });
    expect(parseDollarInput("4")).toEqual({ ok: true, cents: 400 });
    expect(parseDollarInput("4.5")).toEqual({ ok: true, cents: 450 });
    expect(parseDollarInput("0")).toEqual({ ok: true, cents: 0 });
    expect(parseDollarInput("12.99")).toEqual({ ok: true, cents: 1299 });
  });

  it("tolerates surrounding whitespace and a leading $", () => {
    expect(parseDollarInput("  $3.50 ")).toEqual({ ok: true, cents: 350 });
  });

  it("treats an empty entry as no standard price (null)", () => {
    expect(parseDollarInput("")).toEqual({ ok: true, cents: null });
    expect(parseDollarInput("   ")).toEqual({ ok: true, cents: null });
  });

  it("rejects negatives, malformed values and too many decimal places", () => {
    expect(parseDollarInput("-1").ok).toBe(false);
    expect(parseDollarInput("3.555").ok).toBe(false);
    expect(parseDollarInput("3.").ok).toBe(false);
    expect(parseDollarInput("abc").ok).toBe(false);
    expect(parseDollarInput("3,50").ok).toBe(false);
    expect(parseDollarInput("1e3").ok).toBe(false);
  });

  it("does not introduce floating-point error", () => {
    // 0.1 + 0.2 style traps: 19.99, 10.10, 0.07
    expect(parseDollarInput("19.99")).toEqual({ ok: true, cents: 1999 });
    expect(parseDollarInput("10.10")).toEqual({ ok: true, cents: 1010 });
    expect(parseDollarInput("0.07")).toEqual({ ok: true, cents: 7 });
  });
});
