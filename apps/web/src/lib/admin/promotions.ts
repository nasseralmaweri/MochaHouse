import type {
  CreatePromotionRequest,
  PromotionApplicability,
  PromotionDiscountType,
  PromotionKind,
  UpdatePromotionRequest,
} from "@mocha-house/contracts";

// Client-side validation + request shaping for the HQ Promotions & Coupons
// screen (Milestone 7E). The API (`promotions.configure`, CORPORATE-only)
// re-validates everything — these helpers keep the form honest before it
// submits.

export const PROMOTION_NAME_MAX_LENGTH = 120;
export const PROMOTION_DESCRIPTION_MAX_LENGTH = 500;

export interface PromotionFormValues {
  name: string;
  description: string;
  kind: PromotionKind;
  code: string;
  discountType: PromotionDiscountType;
  percentageValue: string;
  fixedAmountDollars: string;
  maxDiscountDollars: string;
  applicability: PromotionApplicability;
  eligibleProductIds: string[];
  eligibleCategoryIds: string[];
  minimumDollars: string;
  appliesToAllLocations: boolean;
  eligibleLocationIds: string[];
  startsAt: string; // <input type="datetime-local"> value
  endsAt: string;
  totalRedemptionLimit: string;
  perCustomerRedemptionLimit: string;
}

export type PreparePromotionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function promotionKindLabel(kind: PromotionKind): string {
  return kind === "AUTOMATIC" ? "Automatic promotion" : "Coupon";
}

export function discountTypeLabel(type: PromotionDiscountType): string {
  return type === "PERCENTAGE_OFF"
    ? "% off"
    : type === "FIXED_AMOUNT"
      ? "Amount off"
      : "Free item";
}

export function applicabilityLabel(a: PromotionApplicability): string {
  return a === "ENTIRE_ORDER"
    ? "Whole order"
    : a === "SELECTED_PRODUCTS"
      ? "Selected products"
      : "Selected categories";
}

function parseWholePositive(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function datetimeLocalToIso(raw: string): string | null | undefined {
  const cleaned = raw.trim();
  if (cleaned === "") return null;
  const date = new Date(cleaned);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function isoToDatetimeLocal(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

interface Validated {
  name: string;
  description: string | null;
  code: string | null;
  discountValue: number;
  maxDiscountMinorUnits: number | null;
  applicability: PromotionApplicability;
  eligibleProductIds: string[];
  eligibleCategoryIds: string[];
  minimumSubtotalMinorUnits: number | null;
  appliesToAllLocations: boolean;
  eligibleLocationIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  totalRedemptionLimit: number | null;
  perCustomerRedemptionLimit: number | null;
}

function validate(
  v: PromotionFormValues,
): { ok: true; value: Validated } | { ok: false; error: string } {
  const name = v.name.trim();
  if (name.length === 0) return err("A promotion name is required.");
  if (name.length > PROMOTION_NAME_MAX_LENGTH)
    return err(`The name must be ${PROMOTION_NAME_MAX_LENGTH} characters or fewer.`);

  const description = v.description.trim();
  if (description.length > PROMOTION_DESCRIPTION_MAX_LENGTH)
    return err(
      `The description must be ${PROMOTION_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    );

  let code: string | null = null;
  if (v.kind === "COUPON") {
    const normalized = v.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(normalized))
      return err(
        "The coupon code must be 3–40 characters: letters, digits, hyphens or underscores.",
      );
    code = normalized;
  } else if (v.code.trim().length > 0) {
    return err("An automatic promotion does not take a coupon code.");
  }

  let discountValue = 0;
  let maxDiscountMinorUnits: number | null = null;
  if (v.discountType === "PERCENTAGE_OFF") {
    const pct = parseWholePositive(v.percentageValue);
    if (pct === null || pct > 100)
      return err("Enter a percentage between 1 and 100.");
    discountValue = pct;
    if (v.maxDiscountDollars.trim().length > 0) {
      const cents = parseDollarsToCents(v.maxDiscountDollars);
      if (cents === null || cents <= 0)
        return err("The maximum discount must be a positive dollar amount.");
      maxDiscountMinorUnits = cents;
    }
  } else if (v.discountType === "FIXED_AMOUNT") {
    const cents = parseDollarsToCents(v.fixedAmountDollars);
    if (cents === null || cents <= 0)
      return err("Enter an amount off above $0, like 5.00.");
    discountValue = cents;
  }

  const productIds = [...new Set(v.eligibleProductIds)];
  const categoryIds = [...new Set(v.eligibleCategoryIds)];
  const applicability = v.applicability;
  if (v.discountType === "FREE_ITEM" && applicability === "ENTIRE_ORDER") {
    return err("A free-item promotion must target selected products or categories.");
  }
  if (applicability === "SELECTED_PRODUCTS" && productIds.length === 0)
    return err("Pick at least one eligible product.");
  if (applicability === "SELECTED_CATEGORIES" && categoryIds.length === 0)
    return err("Pick at least one eligible category.");
  const sendProductIds =
    applicability === "SELECTED_PRODUCTS" ||
    (v.discountType === "FREE_ITEM" && applicability !== "SELECTED_CATEGORIES")
      ? productIds
      : [];
  const sendCategoryIds =
    applicability === "SELECTED_CATEGORIES" ? categoryIds : [];

  let minimumSubtotalMinorUnits: number | null = null;
  if (v.minimumDollars.trim().length > 0) {
    const cents = parseDollarsToCents(v.minimumDollars);
    if (cents === null) return err("The minimum purchase must be a dollar amount.");
    minimumSubtotalMinorUnits = cents;
  }

  const appliesToAllLocations = v.appliesToAllLocations;
  const locationIds = appliesToAllLocations
    ? []
    : [...new Set(v.eligibleLocationIds)];
  if (!appliesToAllLocations && locationIds.length === 0)
    return err("Choose all locations, or select at least one location.");

  const startsAt = datetimeLocalToIso(v.startsAt);
  const endsAt = datetimeLocalToIso(v.endsAt);
  if (startsAt === undefined || endsAt === undefined)
    return err("Enter a valid start and end date, or leave them blank.");
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt)
    return err("The end date must be after the start date.");

  let totalRedemptionLimit: number | null = null;
  if (v.totalRedemptionLimit.trim().length > 0) {
    const n = parseWholePositive(v.totalRedemptionLimit);
    if (n === null) return err("The total redemption limit must be a whole number.");
    totalRedemptionLimit = n;
  }
  let perCustomerRedemptionLimit: number | null = null;
  if (v.perCustomerRedemptionLimit.trim().length > 0) {
    const n = parseWholePositive(v.perCustomerRedemptionLimit);
    if (n === null)
      return err("The per-customer limit must be a whole number.");
    perCustomerRedemptionLimit = n;
  }

  return {
    ok: true,
    value: {
      name,
      description: description === "" ? null : description,
      code,
      discountValue,
      maxDiscountMinorUnits,
      applicability,
      eligibleProductIds: sendProductIds,
      eligibleCategoryIds: sendCategoryIds,
      minimumSubtotalMinorUnits,
      appliesToAllLocations,
      eligibleLocationIds: locationIds,
      startsAt,
      endsAt,
      totalRedemptionLimit,
      perCustomerRedemptionLimit,
    },
  };
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function prepareCreatePromotion(
  v: PromotionFormValues,
): PreparePromotionResult<CreatePromotionRequest> {
  const result = validate(v);
  if (!result.ok) return result;
  const x = result.value;
  return {
    ok: true,
    value: {
      name: x.name,
      description: x.description,
      kind: v.kind,
      code: x.code,
      discountType: v.discountType,
      discountValue: x.discountValue,
      maxDiscountMinorUnits: x.maxDiscountMinorUnits,
      applicability: x.applicability,
      eligibleProductIds: x.eligibleProductIds,
      eligibleCategoryIds: x.eligibleCategoryIds,
      minimumSubtotalMinorUnits: x.minimumSubtotalMinorUnits,
      appliesToAllLocations: x.appliesToAllLocations,
      eligibleLocationIds: x.eligibleLocationIds,
      startsAt: x.startsAt,
      endsAt: x.endsAt,
      totalRedemptionLimit: x.totalRedemptionLimit,
      perCustomerRedemptionLimit: x.perCustomerRedemptionLimit,
    },
  };
}

export function prepareUpdatePromotion(
  v: PromotionFormValues,
): PreparePromotionResult<UpdatePromotionRequest> {
  const result = validate(v);
  if (!result.ok) return result;
  const x = result.value;
  return {
    ok: true,
    value: {
      name: x.name,
      description: x.description,
      code: v.kind === "COUPON" ? x.code : undefined,
      discountValue: x.discountValue,
      maxDiscountMinorUnits: x.maxDiscountMinorUnits,
      applicability: x.applicability,
      eligibleProductIds: x.eligibleProductIds,
      eligibleCategoryIds: x.eligibleCategoryIds,
      minimumSubtotalMinorUnits: x.minimumSubtotalMinorUnits,
      appliesToAllLocations: x.appliesToAllLocations,
      eligibleLocationIds: x.eligibleLocationIds,
      startsAt: x.startsAt,
      endsAt: x.endsAt,
      totalRedemptionLimit: x.totalRedemptionLimit,
      perCustomerRedemptionLimit: x.perCustomerRedemptionLimit,
    },
  };
}
