import type {
  CreateLoyaltyRewardRequest,
  LoyaltyRewardType,
  UpdateLoyaltyRewardRequest,
} from "@mocha-house/contracts";

// Client-side validation + request shaping for the HQ loyalty screens
// (Milestone 7B). The API (`loyalty.configure`, CORPORATE-only) re-validates
// everything — these helpers keep the forms honest before they submit.

export const REWARD_NAME_MAX_LENGTH = 120;
export const REWARD_DESCRIPTION_MAX_LENGTH = 500;
export const EARNING_RATE_MIN = 1;
export const EARNING_RATE_MAX = 100;

// --- Earning rate --------------------------------------------------

export type RateParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parseEarningRate(raw: string): RateParseResult {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) {
    return { ok: false, error: "Enter a whole number of Mocha Beans." };
  }
  const value = Number(cleaned);
  if (value < EARNING_RATE_MIN || value > EARNING_RATE_MAX) {
    return {
      ok: false,
      error: `The rate must be between ${EARNING_RATE_MIN} and ${EARNING_RATE_MAX}.`,
    };
  }
  return { ok: true, value };
}

// --- Reward form -------------------------------------------------

export interface RewardFormValues {
  name: string;
  description: string;
  type: LoyaltyRewardType;
  beanCost: string; // whole number of Beans
  fixedAmountDollars: string; // FIXED_AMOUNT only, e.g. "5.00"
  eligibleProductIds: string[]; // FREE_ITEM only
  eligibleCategoryIds: string[]; // FREE_ITEM only
}

function parseWholePositive(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Dollars string -> integer cents, without floating-point multiplication.
function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export type PrepareRewardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function validateCommon(values: RewardFormValues):
  | { ok: true; name: string; description: string | null; beanCost: number }
  | { ok: false; error: string } {
  const name = values.name.trim();
  if (name.length === 0) {
    return { ok: false, error: "A reward name is required." };
  }
  if (name.length > REWARD_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `The name must be ${REWARD_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  const trimmedDescription = values.description.trim();
  if (trimmedDescription.length > REWARD_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `The description must be ${REWARD_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    };
  }
  const beanCost = parseWholePositive(values.beanCost);
  if (beanCost === null) {
    return { ok: false, error: "The Bean cost must be a whole number above zero." };
  }
  return {
    ok: true,
    name,
    description: trimmedDescription === "" ? null : trimmedDescription,
    beanCost,
  };
}

function validateTypeSpecific(values: RewardFormValues):
  | {
      ok: true;
      fixedAmountMinorUnits: number | null;
      eligibleProductIds: string[];
      eligibleCategoryIds: string[];
    }
  | { ok: false; error: string } {
  if (values.type === "FIXED_AMOUNT") {
    const cents = parseDollarsToCents(values.fixedAmountDollars);
    if (cents === null) {
      return {
        ok: false,
        error: "Enter a dollar-off amount above $0, like 5.00.",
      };
    }
    return {
      ok: true,
      fixedAmountMinorUnits: cents,
      eligibleProductIds: [],
      eligibleCategoryIds: [],
    };
  }
  const products = [...new Set(values.eligibleProductIds)];
  const categories = [...new Set(values.eligibleCategoryIds)];
  if (products.length === 0 && categories.length === 0) {
    return {
      ok: false,
      error: "Pick at least one eligible product or category.",
    };
  }
  return {
    ok: true,
    fixedAmountMinorUnits: null,
    eligibleProductIds: products,
    eligibleCategoryIds: categories,
  };
}

export function prepareCreateReward(
  values: RewardFormValues,
): PrepareRewardResult<CreateLoyaltyRewardRequest> {
  const common = validateCommon(values);
  if (!common.ok) {
    return common;
  }
  const specific = validateTypeSpecific(values);
  if (!specific.ok) {
    return specific;
  }
  return {
    ok: true,
    value: {
      name: common.name,
      description: common.description,
      type: values.type,
      beanCost: common.beanCost,
      ...(values.type === "FIXED_AMOUNT"
        ? { fixedAmountMinorUnits: specific.fixedAmountMinorUnits ?? undefined }
        : {
            eligibleProductIds: specific.eligibleProductIds,
            eligibleCategoryIds: specific.eligibleCategoryIds,
          }),
    },
  };
}

export function prepareUpdateReward(
  values: RewardFormValues,
): PrepareRewardResult<UpdateLoyaltyRewardRequest> {
  const common = validateCommon(values);
  if (!common.ok) {
    return common;
  }
  const specific = validateTypeSpecific(values);
  if (!specific.ok) {
    return specific;
  }
  return {
    ok: true,
    value: {
      name: common.name,
      description: common.description,
      beanCost: common.beanCost,
      ...(values.type === "FIXED_AMOUNT"
        ? { fixedAmountMinorUnits: specific.fixedAmountMinorUnits ?? undefined }
        : {
            eligibleProductIds: specific.eligibleProductIds,
            eligibleCategoryIds: specific.eligibleCategoryIds,
          }),
    },
  };
}

export function rewardTypeLabel(type: LoyaltyRewardType): string {
  return type === "FIXED_AMOUNT" ? "Dollar off" : "Free item";
}
