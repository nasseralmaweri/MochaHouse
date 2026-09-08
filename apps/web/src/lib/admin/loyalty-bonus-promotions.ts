import type {
  CreateLoyaltyBonusPromotionRequest,
  LoyaltyBonusPromotionType,
  UpdateLoyaltyBonusPromotionRequest,
} from "@mocha-house/contracts";

// Client-side validation + request shaping for the HQ Bonus Mocha Beans
// Promotions screen (Milestone 7D). The API (`loyalty.configure`,
// CORPORATE-only) re-validates everything — these helpers keep the form
// honest before it submits.

export const PROMOTION_NAME_MAX_LENGTH = 120;
export const EXTRA_BEANS_MIN = 1;
export const EXTRA_BEANS_MAX = 100_000;
export const MULTIPLIER_MIN = 2;
export const MULTIPLIER_MAX = 10;

export interface BonusPromotionFormValues {
  name: string;
  type: LoyaltyBonusPromotionType;
  bonusValue: string; // whole number
  eligibleProductIds: string[];
  appliesToAllLocations: boolean;
  eligibleLocationIds: string[];
  startsAt: string; // <input type="datetime-local"> value, or ""
  endsAt: string;
}

export type PrepareBonusPromotionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function bonusTypeLabel(type: LoyaltyBonusPromotionType): string {
  return type === "EXTRA_BEANS" ? "Extra Beans" : "Multiplier";
}

// Describe the bonus in one short phrase, e.g. "+20 Bonus Beans" / "2×
// Mocha Beans". Shared by the admin list and any lightweight customer hint.
export function bonusValueLabel(
  type: LoyaltyBonusPromotionType,
  value: number,
): string {
  return type === "EXTRA_BEANS"
    ? `+${value} Bonus Beans`
    : `${value}× Mocha Beans`;
}

function parseWhole(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

// A <input type="datetime-local"> value ("2026-09-10T14:30") is a local
// wall-clock time. Convert to an absolute ISO string; "" -> null.
function datetimeLocalToIso(raw: string): string | null | undefined {
  const cleaned = raw.trim();
  if (cleaned === "") {
    return null;
  }
  const date = new Date(cleaned);
  if (Number.isNaN(date.getTime())) {
    return undefined; // signal invalid
  }
  return date.toISOString();
}

function validate(values: BonusPromotionFormValues):
  | {
      ok: true;
      name: string;
      bonusValue: number;
      productIds: string[];
      appliesToAllLocations: boolean;
      locationIds: string[];
      startsAt: string | null;
      endsAt: string | null;
    }
  | { ok: false; error: string } {
  const name = values.name.trim();
  if (name.length === 0) {
    return { ok: false, error: "A promotion name is required." };
  }
  if (name.length > PROMOTION_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `The name must be ${PROMOTION_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }

  const bonusValue = parseWhole(values.bonusValue);
  if (bonusValue === null) {
    return { ok: false, error: "The bonus value must be a whole number." };
  }
  if (values.type === "EXTRA_BEANS") {
    if (bonusValue < EXTRA_BEANS_MIN || bonusValue > EXTRA_BEANS_MAX) {
      return {
        ok: false,
        error: `Extra Beans must be between ${EXTRA_BEANS_MIN} and ${EXTRA_BEANS_MAX}.`,
      };
    }
  } else if (bonusValue < MULTIPLIER_MIN || bonusValue > MULTIPLIER_MAX) {
    return {
      ok: false,
      error: `The multiplier must be between ${MULTIPLIER_MIN} and ${MULTIPLIER_MAX}.`,
    };
  }

  const productIds = [...new Set(values.eligibleProductIds)];
  if (productIds.length === 0) {
    return { ok: false, error: "Pick at least one eligible product." };
  }

  const appliesToAllLocations = values.appliesToAllLocations;
  const locationIds = appliesToAllLocations
    ? []
    : [...new Set(values.eligibleLocationIds)];
  if (!appliesToAllLocations && locationIds.length === 0) {
    return {
      ok: false,
      error: "Choose all locations, or select at least one location.",
    };
  }

  const startsAt = datetimeLocalToIso(values.startsAt);
  const endsAt = datetimeLocalToIso(values.endsAt);
  if (startsAt === undefined || endsAt === undefined) {
    return { ok: false, error: "Enter a valid start and end date, or leave blank." };
  }
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    return { ok: false, error: "The end date must be after the start date." };
  }

  return {
    ok: true,
    name,
    bonusValue,
    productIds,
    appliesToAllLocations,
    locationIds,
    startsAt,
    endsAt,
  };
}

export function prepareCreateBonusPromotion(
  values: BonusPromotionFormValues,
): PrepareBonusPromotionResult<CreateLoyaltyBonusPromotionRequest> {
  const v = validate(values);
  if (!v.ok) {
    return v;
  }
  return {
    ok: true,
    value: {
      name: v.name,
      type: values.type,
      bonusValue: v.bonusValue,
      eligibleProductIds: v.productIds,
      appliesToAllLocations: v.appliesToAllLocations,
      eligibleLocationIds: v.locationIds,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
    },
  };
}

export function prepareUpdateBonusPromotion(
  values: BonusPromotionFormValues,
): PrepareBonusPromotionResult<UpdateLoyaltyBonusPromotionRequest> {
  const v = validate(values);
  if (!v.ok) {
    return v;
  }
  return {
    ok: true,
    value: {
      name: v.name,
      bonusValue: v.bonusValue,
      eligibleProductIds: v.productIds,
      appliesToAllLocations: v.appliesToAllLocations,
      eligibleLocationIds: v.locationIds,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
    },
  };
}

// An ISO string -> the value a <input type="datetime-local"> expects, in
// the viewer's local time. "" for null.
export function isoToDatetimeLocal(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
