import type { AdminGiftCardDetail } from "@mocha-house/contracts";
import type { GiftCardMutationResult } from "@/lib/api-client";
import {
  GIFT_CARD_OPERATION_KEY_CONFLICT,
  canSubmitCorrection,
  correctionStepAfter,
  correctionWouldBeOutOfRange,
  normalizeGiftCardQuery,
  prepareConfiguration,
  prepareCorrection,
  prepareIssue,
} from "./gift-cards";

// SC0.5d — the correction form's recovery rules after each result.
describe("correctionStepAfter", () => {
  const KEY = "key-current-0001";
  let minted: number;
  const mint = () => {
    minted += 1;
    return `key-new-${minted}`;
  };
  beforeEach(() => {
    minted = 0;
  });

  const detail = {
    giftCard: { balanceMinorUnits: 5750, currency: "USD" },
    transactions: [],
  } as unknown as AdminGiftCardDetail;
  const step = (result: GiftCardMutationResult<AdminGiftCardDetail>) =>
    correctionStepAfter(result, KEY, mint);

  it("a confirmed success rotates the key, clears the inputs and refreshes the card", () => {
    expect(step({ outcome: "success", data: detail })).toEqual({
      operationKey: "key-new-1",
      clearInputs: true,
      refresh: true,
      reviewRequired: false,
      error: null,
      notice: "Balance is now $57.50.",
    });
  });

  it("a key conflict rotates the key, keeps the inputs, refreshes the card and requires a review", () => {
    expect(
      step({
        outcome: "conflict",
        code: GIFT_CARD_OPERATION_KEY_CONFLICT,
        message: "Server says: key already used.",
      }),
    ).toEqual({
      operationKey: "key-new-1",
      clearInputs: false,
      refresh: true,
      reviewRequired: true,
      error: "Server says: key already used.",
      notice: null,
    });
  });

  it.each([
    [
      "a network error",
      { outcome: "error", message: "Could not reach the server." },
    ],
    [
      "a timeout / gateway timeout (outcome unknown)",
      { outcome: "error", message: "Something went wrong (504)." },
    ],
    [
      "a server error (outcome unknown)",
      { outcome: "error", message: "Something went wrong (500)." },
    ],
  ] as const)(
    "%s keeps the SAME key and the inputs, refreshes nothing and asks for no review",
    (_label, result) => {
      expect(step(result)).toEqual({
        operationKey: KEY,
        clearInputs: false,
        refresh: false,
        reviewRequired: false,
        error: result.message,
        notice: null,
      });
      expect(minted).toBe(0);
    },
  );

  it.each([
    [
      "another 409 (e.g. balance would go below $0.00)",
      { outcome: "conflict", message: "Below $0.00." },
      "Below $0.00.",
    ],
    [
      "a 409 with an unrelated code",
      { outcome: "conflict", code: "SOMETHING_ELSE", message: "No." },
      "No.",
    ],
    [
      "a 400",
      { outcome: "invalid", message: "A reason is required." },
      "A reason is required.",
    ],
    [
      "a 403",
      { outcome: "forbidden" },
      "You don't have permission to correct gift-card balances.",
    ],
    [
      "a 404",
      { outcome: "not-found" },
      "This gift card no longer exists.",
    ],
  ] as const)(
    "%s keeps the existing behaviour: same key, same inputs, message shown",
    (_label, result, message) => {
      expect(step(result)).toEqual({
        operationKey: KEY,
        clearInputs: false,
        refresh: false,
        reviewRequired: false,
        error: message,
        notice: null,
      });
      expect(minted).toBe(0);
    },
  );

  it("never resubmits: it only describes the next state (no request effect exists)", () => {
    const result = step({
      outcome: "conflict",
      code: GIFT_CARD_OPERATION_KEY_CONFLICT,
      message: "x",
    });
    expect(Object.keys(result).sort()).toEqual([
      "clearInputs",
      "error",
      "notice",
      "operationKey",
      "refresh",
      "reviewRequired",
    ]);
  });
});

describe("canSubmitCorrection", () => {
  const base = {
    pending: false,
    reviewRequired: false,
    reviewed: false,
    refreshing: false,
  };

  it("blocks resubmission after a key conflict until the operator confirms the review", () => {
    expect(canSubmitCorrection({ ...base, reviewRequired: true })).toBe(false);
    expect(
      canSubmitCorrection({ ...base, reviewRequired: true, reviewed: true }),
    ).toBe(true);
  });

  it("blocks a confirmed review until the refreshed balance and ledger have landed", () => {
    expect(
      canSubmitCorrection({
        ...base,
        reviewRequired: true,
        reviewed: true,
        refreshing: true,
      }),
    ).toBe(false);
  });

  it("allows a normal submission (even while a post-success refresh runs) and blocks while one is in flight", () => {
    expect(canSubmitCorrection(base)).toBe(true);
    expect(canSubmitCorrection({ ...base, refreshing: true })).toBe(true);
    expect(canSubmitCorrection({ ...base, pending: true, reviewed: true })).toBe(
      false,
    );
  });
});

// Milestone 7F — the HQ gift-card form helpers. Pure logic; the API
// re-validates everything.
describe("gift-card admin helpers", () => {
  describe("prepareIssue", () => {
    it("accepts a valid dollar amount and converts to minor units", () => {
      expect(prepareIssue("25")).toEqual({
        ok: true,
        value: { originalValueMinorUnits: 2500 },
      });
      expect(prepareIssue("$10.50")).toEqual({
        ok: true,
        value: { originalValueMinorUnits: 1050 },
      });
    });

    it("rejects zero, blank, non-money and over-ceiling amounts", () => {
      expect(prepareIssue("").ok).toBe(false);
      expect(prepareIssue("0").ok).toBe(false);
      expect(prepareIssue("abc").ok).toBe(false);
      expect(prepareIssue("2000.01").ok).toBe(false);
      expect(prepareIssue("2000").ok).toBe(true);
    });
  });

  describe("prepareCorrection", () => {
    const key = "op-key-12345678";

    it("builds a signed delta from direction + amount", () => {
      expect(
        prepareCorrection(
          { direction: "add", amount: "5", reason: "Goodwill" },
          key,
        ),
      ).toEqual({
        ok: true,
        value: { deltaMinorUnits: 500, reason: "Goodwill", operationKey: key },
      });
      expect(
        prepareCorrection(
          { direction: "deduct", amount: "5", reason: "Fix double issue" },
          key,
        ),
      ).toEqual({
        ok: true,
        value: {
          deltaMinorUnits: -500,
          reason: "Fix double issue",
          operationKey: key,
        },
      });
    });

    it("requires a non-empty reason and a positive amount", () => {
      expect(
        prepareCorrection(
          { direction: "add", amount: "5", reason: "   " },
          key,
        ).ok,
      ).toBe(false);
      expect(
        prepareCorrection(
          { direction: "add", amount: "0", reason: "x" },
          key,
        ).ok,
      ).toBe(false);
      expect(
        prepareCorrection(
          { direction: "add", amount: "9999", reason: "x" },
          key,
        ).ok,
      ).toBe(false);
    });
  });

  describe("correctionWouldBeOutOfRange", () => {
    it("flags below zero and above the ceiling", () => {
      expect(correctionWouldBeOutOfRange(1000, -1500)).toBe(true);
      expect(correctionWouldBeOutOfRange(199_000, 2000)).toBe(true);
      expect(correctionWouldBeOutOfRange(1000, 500)).toBe(false);
      expect(correctionWouldBeOutOfRange(1000, -1000)).toBe(false);
    });
  });

  describe("prepareConfiguration", () => {
    it("normalizes, sorts and de-duplicates preset amounts", () => {
      expect(
        prepareConfiguration({
          presetInputs: ["50", "10", "25", " "],
          customAmountEnabled: false,
        }),
      ).toEqual({
        ok: true,
        value: {
          presetAmountsMinorUnits: [1000, 2500, 5000],
          customAmountEnabled: false,
        },
      });
    });

    it("rejects empty, duplicate, invalid or over-ceiling entries", () => {
      expect(
        prepareConfiguration({ presetInputs: [], customAmountEnabled: true }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["10", "10"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["10", "abc"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["2500"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
    });
  });

  describe("normalizeGiftCardQuery", () => {
    it("trims", () => {
      expect(normalizeGiftCardQuery("  ABCD 1234  ")).toBe("ABCD 1234");
    });
  });
});
