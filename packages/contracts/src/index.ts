export interface LocationSummary {
  id: string;
  name: string;
  slug: string;
  isDigitalOrderingEnabled: boolean;
}

export interface MenuSummary {
  id: string;
  name: string;
  slug: string;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
}

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  basePrice: number | null;
  currency: string;
  category: CategorySummary;
}

export interface ModifierOptionSummary {
  id: string;
  name: string;
  priceAdjustment: number;
  displayOrder: number;
}

export interface ModifierGroupSummary {
  id: string;
  name: string;
  displayOrder: number;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number | null;
  options: ModifierOptionSummary[];
}

export interface EffectiveMenuProduct {
  displayOrder: number;
  effectivePrice: number | null;
  isAvailable: boolean;
  product: ProductSummary;
  modifierGroups: ModifierGroupSummary[];
}

export interface LocationMenuResponse {
  location: LocationSummary;
  menu: {
    id: string;
    name: string;
    slug: string;
    products: EffectiveMenuProduct[];
  };
}

// --- Admin locations: read experience (Milestone 5D-1) ----------------
// The Admin-facing view of a Location record. Distinct from the customer
// `LocationSummary` above: this is served only from the guarded
// `/api/v1/admin/locations*` routes (InternalAuthGuard + PermissionGuard +
// `locations.view` + resource-level scope), and it deliberately exposes
// `isActive` — an Admin user may see and open inactive locations, which the
// public endpoints filter out entirely. The address, contact, time zone and
// opening hours (SC4d) are on the detail only.
export interface AdminLocationSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
}

// The menu currently assigned to a location through an active LocationMenu
// row (active menu only). Null when the location has no active assigned
// menu. `productCount` is the number of active MenuProduct rows on that
// menu — a cheap count from the same relationship, not a second traversal
// of the effective-menu resolver.
export interface AdminLocationAssignedMenu {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  productCount: number;
}

export interface AdminLocationDetail extends AdminLocationSummary {
  assignedMenu: AdminLocationAssignedMenu | null;
  // SC4d — address, contact and time zone, and the weekly opening hours.
  profile: AdminLocationProfile;
  openingHours: AdminOpeningHours;
}

// --- Admin locations: minimal edit (Milestone 5D-2) -------------------
// PATCH /api/v1/admin/locations/:locationId — a CORPORATE-only edit
// (`locations.edit`). Only these two fields are editable; `slug` and
// `isDigitalOrderingEnabled` are deliberately NOT accepted here (slug is a
// stable public identifier; online ordering has its own control and
// permission). Every field is optional; omitting all of them is a no-op
// that returns the unchanged record. The response is the full
// `AdminLocationDetail` so the caller can refresh the screen without a
// second request.
export interface AdminUpdateLocationRequest {
  name?: string;
  isActive?: boolean;
}

// --- SC4d: location profile, opening hours and the first location ------
// A location's address, contact phone and IANA time zone. Every field is
// null on a location created before SC4d until someone fills it in; a
// location an owner creates always has the required ones (see
// `validateLocationProfile`).
export interface AdminLocationProfile {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  // ISO 3166-1 alpha-2, upper case.
  countryCode: string | null;
  // IANA time zone, e.g. "America/New_York".
  timeZone: string | null;
  phone: string | null;
}

// One opening period, in the location's local time: "HH:MM", 00:00–23:59
// for the opening time and 00:01–24:00 for the closing time. A closing time
// earlier than the opening time runs past midnight into the next day.
export interface OpeningPeriod {
  opensAt: string;
  closesAt: string;
}

// ISO weekday: 1 = Monday … 7 = Sunday. A day with no periods is closed.
export interface OpeningDay {
  dayOfWeek: number;
  periods: OpeningPeriod[];
}

// Always seven days, Monday first. `isSet` is false until hours have been
// saved once (so "not set up yet" is never shown as "closed every day").
export interface AdminOpeningHours {
  isSet: boolean;
  days: OpeningDay[];
}

// PUT /api/v1/admin/locations/:locationId/hours — the whole week at once.
// Days left out are closed.
export interface AdminSetOpeningHoursRequest {
  days: OpeningDay[];
}

// PUT /api/v1/admin/locations/:locationId/profile (`locations.edit`) and the
// body of POST /api/v1/admin/locations (`locations.create`).
export interface AdminLocationProfileRequest {
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
  timeZone: string;
  phone: string;
}

export type AdminCreateLocationRequest = AdminLocationProfileRequest;

// 409 from POST /api/v1/admin/locations: SC4d lets a business create its
// FIRST location only. `locationId` is the location it already has.
export const LOCATION_LIMIT_REACHED = "LOCATION_LIMIT_REACHED";

export interface LocationLimitReachedBody {
  code: typeof LOCATION_LIMIT_REACHED;
  message: string;
  locationId: string | null;
}

export const LOCATION_NAME_MAX_LENGTH = 80;
export const LOCATION_ADDRESS_LINE_MAX_LENGTH = 200;
export const LOCATION_CITY_MAX_LENGTH = 100;
export const LOCATION_REGION_MAX_LENGTH = 100;
export const LOCATION_POSTAL_CODE_MAX_LENGTH = 20;
export const LOCATION_PHONE_MAX_LENGTH = 30;
export const OPENING_PERIODS_PER_DAY_MAX = 4;

// ISO 3166-1 alpha-2 country codes (officially assigned).
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
  "QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

export interface ValidLocationProfile {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  timeZone: string;
  phone: string;
}

export type LocationProfileValidation =
  | { ok: true; value: ValidLocationProfile }
  | { ok: false; field: keyof AdminLocationProfileRequest; message: string };

type ProfileTextResult =
  | { ok: true; value: string | null }
  | { ok: false; field: keyof AdminLocationProfileRequest; message: string };

function profileText(
  input: Record<string, unknown>,
  field: keyof AdminLocationProfileRequest,
  label: string,
  max: number,
  required: boolean,
): ProfileTextResult {
  const raw = input[field];
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "")
  ) {
    return required
      ? { ok: false, field, message: `Enter the ${label}.` }
      : { ok: true, value: null };
  }
  // NUL and other control characters are refused (tabs and line breaks are
  // collapsed into spaces below).
  if (
    typeof raw !== "string" ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)
  ) {
    return {
      ok: false,
      field,
      message: `The ${label} contains invalid characters.`,
    };
  }
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length > max) {
    return {
      ok: false,
      field,
      message: `The ${label} must be at most ${max} characters.`,
    };
  }
  return { ok: true, value };
}

// The ONE profile rule, shared by the API (authoritative) and the web form.
// Required: name, first address line, city, country, time zone and phone;
// region and postal code are optional (not every country uses them).
export function validateLocationProfile(
  input: Record<string, unknown>,
  isTimeZone: (value: string) => boolean = isSupportedTimeZone,
): LocationProfileValidation {
  const name = profileText(input, "name", "location name", LOCATION_NAME_MAX_LENGTH, true);
  if (!name.ok) return name;
  const addressLine1 = profileText(
    input,
    "addressLine1",
    "street address",
    LOCATION_ADDRESS_LINE_MAX_LENGTH,
    true,
  );
  if (!addressLine1.ok) return addressLine1;
  const addressLine2 = profileText(
    input,
    "addressLine2",
    "second address line",
    LOCATION_ADDRESS_LINE_MAX_LENGTH,
    false,
  );
  if (!addressLine2.ok) return addressLine2;
  const city = profileText(input, "city", "city", LOCATION_CITY_MAX_LENGTH, true);
  if (!city.ok) return city;
  const region = profileText(
    input,
    "region",
    "state or region",
    LOCATION_REGION_MAX_LENGTH,
    false,
  );
  if (!region.ok) return region;
  const postalCode = profileText(
    input,
    "postalCode",
    "postal code",
    LOCATION_POSTAL_CODE_MAX_LENGTH,
    false,
  );
  if (!postalCode.ok) return postalCode;
  if (
    postalCode.value !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(postalCode.value)
  ) {
    return {
      ok: false,
      field: "postalCode",
      message:
        "The postal code may contain only letters, numbers, spaces and hyphens.",
    };
  }

  const country = input.countryCode;
  const countryCode =
    typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!COUNTRY_CODE_SET.has(countryCode)) {
    return { ok: false, field: "countryCode", message: "Choose the country." };
  }

  const zone = input.timeZone;
  const timeZone = typeof zone === "string" ? zone.trim() : "";
  if (timeZone === "" || timeZone.length > 64 || !isTimeZone(timeZone)) {
    return {
      ok: false,
      field: "timeZone",
      message: "Choose the location's time zone.",
    };
  }

  const phone = profileText(input, "phone", "phone number", LOCATION_PHONE_MAX_LENGTH, true);
  if (!phone.ok) return phone;
  const phoneValue = phone.value ?? "";
  const digits = phoneValue.replace(/\D/g, "").length;
  if (!/^\+?[0-9 ().\-/]+$/.test(phoneValue) || digits < 7 || digits > 15) {
    return {
      ok: false,
      field: "phone",
      message:
        "Enter a phone number with 7 to 15 digits (for example +1 555 123 4567).",
    };
  }

  return {
    ok: true,
    value: {
      name: name.value!,
      addressLine1: addressLine1.value!,
      addressLine2: addressLine2.value,
      city: city.value!,
      region: region.value,
      postalCode:
        postalCode.value === null ? null : postalCode.value.toUpperCase(),
      countryCode,
      timeZone,
      phone: phoneValue,
    },
  };
}

// The IANA time zones this runtime knows (canonical names), plus "UTC".
// Aliases such as "EST" or "US/Eastern" are not offered or accepted.
export function supportedTimeZones(): readonly string[] {
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  const zones = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
}

let timeZoneSet: ReadonlySet<string> | null = null;

export function isSupportedTimeZone(value: string): boolean {
  timeZoneSet ??= new Set(supportedTimeZones());
  return timeZoneSet.has(value);
}

const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

// "HH:MM" -> minutes after midnight. Opening times are 00:00–23:59; closing
// times 00:01–24:00 (24:00 = end of the day). Null when malformed.
export function parseClockTime(value: unknown, closing: boolean): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > DAY_MINUTES) return null;
  if (closing ? minutes === 0 : minutes === DAY_MINUTES) return null;
  return minutes;
}

export function formatClockMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export interface StoredOpeningPeriod {
  dayOfWeek: number;
  opensAtMinute: number;
  closesAtMinute: number;
}

export type OpeningHoursValidation =
  | { ok: true; periods: StoredOpeningPeriod[] }
  | { ok: false; message: string };

const MALFORMED_HOURS = "The opening hours are malformed.";

// The ONE opening-hours rule, shared by the API (authoritative) and the web
// form. Each day at most once; at most OPENING_PERIODS_PER_DAY_MAX periods a
// day; no zero-length period; and no two periods of the week may overlap —
// including a period that runs past midnight into the next day's first one,
// and Sunday night into Monday morning. Periods that only touch (one closes
// at 12:00, the next opens at 12:00) are allowed.
export function validateOpeningHours(input: unknown): OpeningHoursValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: MALFORMED_HOURS };
  }
  const days = (input as { days?: unknown }).days;
  if (!Array.isArray(days) || days.length > 7) {
    return { ok: false, message: MALFORMED_HOURS };
  }
  const seen = new Set<number>();
  const periods: StoredOpeningPeriod[] = [];
  for (const day of days as unknown[]) {
    if (typeof day !== "object" || day === null) {
      return { ok: false, message: MALFORMED_HOURS };
    }
    const { dayOfWeek, periods: dayPeriods } = day as {
      dayOfWeek?: unknown;
      periods?: unknown;
    };
    if (
      typeof dayOfWeek !== "number" ||
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 1 ||
      dayOfWeek > 7 ||
      seen.has(dayOfWeek)
    ) {
      return {
        ok: false,
        message: "Each day of the week can appear only once.",
      };
    }
    seen.add(dayOfWeek);
    const dayName = WEEKDAY_NAMES[dayOfWeek - 1];
    if (!Array.isArray(dayPeriods)) {
      return { ok: false, message: `${dayName}: the opening times are malformed.` };
    }
    if (dayPeriods.length > OPENING_PERIODS_PER_DAY_MAX) {
      return {
        ok: false,
        message: `${dayName}: at most ${OPENING_PERIODS_PER_DAY_MAX} opening periods a day.`,
      };
    }
    for (const period of dayPeriods as unknown[]) {
      const record = (
        typeof period === "object" && period !== null ? period : {}
      ) as { opensAt?: unknown; closesAt?: unknown };
      const opens = parseClockTime(record.opensAt, false);
      const closes = parseClockTime(record.closesAt, true);
      if (opens === null || closes === null) {
        return {
          ok: false,
          message: `${dayName}: enter opening and closing times as HH:MM (closing may be 24:00).`,
        };
      }
      if (opens === closes) {
        return {
          ok: false,
          message: `${dayName}: a period can't open and close at the same time.`,
        };
      }
      periods.push({ dayOfWeek, opensAtMinute: opens, closesAtMinute: closes });
    }
  }

  // Lay every period on one week of minutes (Monday 00:00 = 0). A period
  // closing earlier than it opens ends the next day; one ending after Sunday
  // midnight wraps to Monday morning.
  const spans: Array<{ start: number; end: number; day: number }> = [];
  for (const period of periods) {
    const start = (period.dayOfWeek - 1) * DAY_MINUTES + period.opensAtMinute;
    const length =
      period.closesAtMinute > period.opensAtMinute
        ? period.closesAtMinute - period.opensAtMinute
        : period.closesAtMinute + DAY_MINUTES - period.opensAtMinute;
    const end = start + length;
    if (end <= WEEK_MINUTES) {
      spans.push({ start, end, day: period.dayOfWeek });
    } else {
      spans.push({ start, end: WEEK_MINUTES, day: period.dayOfWeek });
      spans.push({ start: 0, end: end - WEEK_MINUTES, day: period.dayOfWeek });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      const first = WEEKDAY_NAMES[spans[i - 1].day - 1];
      const second = WEEKDAY_NAMES[spans[i].day - 1];
      return {
        ok: false,
        message:
          first === second
            ? `${first}: opening periods overlap.`
            : `${first} and ${second}: opening periods overlap.`,
      };
    }
  }

  periods.sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.opensAtMinute - b.opensAtMinute,
  );
  return { ok: true, periods };
}

// Stored periods -> the seven-day view, Monday first.
export function openingHoursView(
  isSet: boolean,
  periods: readonly StoredOpeningPeriod[],
): AdminOpeningHours {
  return {
    isSet,
    days: WEEKDAY_NAMES.map((_, index) => ({
      dayOfWeek: index + 1,
      periods: periods
        .filter((period) => period.dayOfWeek === index + 1)
        .sort((a, b) => a.opensAtMinute - b.opensAtMinute)
        .map((period) => ({
          opensAt: formatClockMinutes(period.opensAtMinute),
          closesAt: formatClockMinutes(period.closesAtMinute),
        })),
    })),
  };
}

// --- SC4d: business menus ---------------------------------------------
// POST /api/v1/admin/catalog/menus (`catalog.menu.manage`). Creating a menu
// with the name of one the business already has returns that menu
// (`created: false`) — a repeated or double-clicked submission never makes
// a second menu.
export interface AdminCreateMenuRequest {
  name: string;
  slug?: string | null;
}

export interface AdminCreateMenuResponse {
  menu: AdminMenuSummary;
  created: boolean;
}

// PUT /api/v1/admin/catalog/locations/:locationId/menu
// (`catalog.menu.manage`): the menu this location sells from. Replaces any
// other active menu of the location; repeating it changes nothing.
export interface AdminAssignLocationMenuRequest {
  menuId: string;
}

export interface AdminAssignLocationMenuResponse {
  locationId: string;
  menuId: string;
  changed: boolean;
}

// --- SC4d: getting started ----------------------------------------------
// GET /api/v1/admin/getting-started — computed on every request from the
// business's real data (nothing stored). "Setup complete" means these steps
// are done; it is NOT "publicly live": the business storefront and other
// launch requirements are separate.
export const GETTING_STARTED_STEP_KEYS = [
  "business",
  "billing",
  "location",
  "profile",
  "hours",
  "menu",
  "ordering",
] as const;

export type GettingStartedStepKey = (typeof GETTING_STARTED_STEP_KEYS)[number];

export interface GettingStartedStep {
  key: GettingStartedStepKey;
  done: boolean;
}

export interface AdminGettingStartedResponse {
  steps: GettingStartedStep[];
  completedCount: number;
  totalCount: number;
  setupComplete: boolean;
  // The location the steps refer to (the business's first), when it has one.
  locationId: string | null;
  // That location's menu, when it has one.
  menuId: string | null;
  // Whether this deployment's customer storefront serves this business today.
  // False for every self-service business until multi-business storefront
  // routing (SC4f): its online ordering can be on, but customers cannot reach
  // it yet.
  storefrontLive: boolean;
}

// 409 from PATCH /api/v1/admin/locations/:id/digital-ordering when online
// ordering is turned ON for a self-service business's location that is not
// ready yet. `missing` lists the getting-started steps still to do.
export const LOCATION_ORDERING_NOT_READY = "LOCATION_ORDERING_NOT_READY";

export interface LocationOrderingNotReadyBody {
  code: typeof LOCATION_ORDERING_NOT_READY;
  message: string;
  missing: GettingStartedStepKey[];
}

// --- Admin products: master catalog management (Milestone 5D-3) -------
// The Admin view of a master Product. Served only from the guarded
// `/api/v1/admin/catalog/products*` routes (InternalAuthGuard +
// PermissionGuard + `catalog.view`, which is CORPORATE-only — the master
// catalog is shared across every location, not location-owned). Unlike the
// public `ProductSummary` this exposes `isActive` (an Admin sees and edits
// inactive products too) and omits `category.slug` / `displayOrder` (not
// used by this screen). `basePrice` is integer minor units (cents) or null;
// null means "no standard price" — the item is only orderable at a location
// that sets its own price. No menu / modifier / override / POS fields.
export interface AdminProductCategoryRef {
  id: string;
  name: string;
}

export interface AdminProductSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  basePrice: number | null;
  currency: string;
  isActive: boolean;
  category: AdminProductCategoryRef;
}

// Currently identical to the summary — a distinct name so the detail route
// (and the PATCH response) can carry more later without a breaking rename.
export type AdminProductDetail = AdminProductSummary;

// PATCH /api/v1/admin/catalog/products/:productId — permission
// `catalog.products.edit` (CORPORATE-only). Only these fields are editable.
// `slug`, `categoryId`, `currency`, and everything else are deliberately not
// accepted (the controller reads only the fields below — nothing is spread
// into Prisma). Every field is optional; `description` / `basePrice` accept
// null to clear them. Response is the full `AdminProductDetail`.
export interface AdminUpdateProductRequest {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

// --- Admin catalog creation (S1) --------------------------------------
// Categories, products and menu placements created from the Admin. Every
// route is CORPORATE-only (`catalog.products.edit` for categories and
// products, `catalog.menu.manage` for placements) and writes the server-
// resolved business only. Slugs ("web addresses") are generated from the
// name unless one is supplied, are unique within the business and are not
// editable afterwards. Prices are integer cents.
export const CATALOG_NAME_MAX_LENGTH = 120;
export const CATALOG_DESCRIPTION_MAX_LENGTH = 1000;
export const CATALOG_SLUG_MAX_LENGTH = 80;
// Upper bound for a product's standard price: $1,000.00.
export const CATALOG_MAX_PRICE_MINOR_UNITS = 100_000;

const CATALOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Lower-case letters, digits and single hyphens, 1..CATALOG_SLUG_MAX_LENGTH.
export function isValidCatalogSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CATALOG_SLUG_MAX_LENGTH &&
    CATALOG_SLUG_PATTERN.test(value)
  );
}

// The slug the server generates from a name (accents dropped, anything else
// collapsed to single hyphens). Empty when the name has no usable letters
// or digits — the server then falls back to a generic slug.
export function slugifyCatalogName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATALOG_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export interface AdminCategorySummary {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActive: boolean;
  productCount: number;
}

// POST /api/v1/admin/catalog/categories. `slug` is optional (generated from
// the name when omitted). New categories are placed after existing ones.
// Response 201: `AdminCategorySummary`.
export interface AdminCreateCategoryRequest {
  name: string;
  slug?: string | null;
  isActive?: boolean;
}

// POST /api/v1/admin/catalog/products. Creating a product never places it
// on a menu — it reaches customers only once it is added to a menu (and
// shown there). `basePrice` null means "no standard price" exactly as on
// edit. Response 201: `AdminProductDetail`.
export interface AdminCreateProductRequest {
  name: string;
  categoryId: string;
  description?: string | null;
  basePrice: number | null;
  isActive?: boolean;
  slug?: string | null;
}

// POST /api/v1/admin/catalog/menus/:menuId/products. Idempotent: adds the
// product to the menu if it is not there yet (hidden unless `isActive` is
// true, at the end of the menu) and otherwise returns the existing
// placement unchanged — use the assignment PATCH to show / hide it.
// Response 201 when created, 200 when it already existed.
export interface AdminAddMenuProductRequest {
  productId: string;
  isActive?: boolean;
}

export interface AdminMenuPlacement {
  menuId: string;
  productId: string;
  displayOrder: number;
  isActive: boolean;
}

export interface AdminAddMenuProductResponse {
  placement: AdminMenuPlacement;
  created: boolean;
}

// --- Admin menus & location pricing (Milestone 5D-4) -----------------
// Read models for the two Admin screens that manage EXISTING menu
// composition and EXISTING per-location price / availability. The field
// names are deliberately business-facing: "standard price" (the master
// product price), "location price" (a price set for one location, or null
// when the location uses the standard price), "resulting price" (what
// actually applies). No override / resolver / join terminology, and no
// modifier internals.

// Served from `/api/v1/admin/catalog/menus*` (InternalAuthGuard +
// PermissionGuard + `catalog.view`, CORPORATE-only). Includes inactive
// menus and inactive menu placements — an Admin manages both.
export interface AdminMenuSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

// One product placed on a menu. `shownOnMenu` is whether that placement is
// currently on (the only thing 5D-4 can change here); `productIsActive` is
// the master product's own state — the two are independent, and an inactive
// product never reaches customers even when it is "shown on menu".
export interface AdminMenuProduct {
  productId: string;
  productName: string;
  productIsActive: boolean;
  categoryName: string;
  standardPrice: number | null;
  currency: string;
  shownOnMenu: boolean;
  // Internal ordering only — the UI renders products in this order.
  displayOrder: number;
}

export interface AdminMenuDetail extends AdminMenuSummary {
  products: AdminMenuProduct[];
}

// Served from `GET /api/v1/admin/catalog/locations/:locationId/menu`
// (InternalAuthGuard + PermissionGuard + `catalog.overrides.manage`, valid
// at CORPORATE or LOCATION scope). Resolves the location's assigned menu
// and, per product, the standard price/availability, any location-specific
// setting, and the resulting value. 404 when the location has no menu.
export interface AdminLocationMenuProduct {
  productId: string;
  productName: string;
  productIsActive: boolean;
  categoryName: string;
  currency: string;
  shownOnMenu: boolean;
  // The master product price.
  standardPrice: number | null;
  // A price set just for this location, or null when this location uses the
  // standard price.
  locationPrice: number | null;
  // What a customer at this location is actually charged: the location
  // price when one is set, otherwise the standard price. Null only when
  // neither exists — the item then has no usable price here.
  resultingPrice: number | null;
  // An availability set just for this location, or null when this location
  // uses the standard behavior (available).
  locationAvailability: boolean | null;
  // Whether the item can currently be ordered here: the location setting
  // when present, otherwise available.
  resultingAvailability: boolean;
}

export interface AdminLocationMenuResponse {
  location: { id: string; name: string };
  menu: { id: string; name: string };
  products: AdminLocationMenuProduct[];
}

// --- Admin product modifiers (Product Modifier Management) ------------
// A business's reusable modifier groups ("Size", "Milk") and their options,
// attached to any number of its products. Reads need `catalog.view`;
// every change needs `catalog.products.edit` (both CORPORATE-only). Editing
// a shared group changes every product it is attached to. Prices are
// integer cents. "Required" is derived: a group is required exactly when
// its minimum is at least 1.
export const MODIFIER_MAX_SELECTIONS_LIMIT = 20;
// Upper bound for an option's price adjustment: $100.00. Never negative.
export const MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS = 10_000;
// Request-size bounds.
export const MODIFIER_GROUP_MAX_OPTIONS = 50;
export const PRODUCT_MAX_MODIFIER_GROUPS = 20;

export interface AdminModifierOption {
  id: string;
  name: string;
  priceAdjustment: number;
  displayOrder: number;
  isActive: boolean;
}

export interface AdminModifierGroupSummary {
  id: string;
  name: string;
  isRequired: boolean;
  minSelections: number;
  // null: no upper limit.
  maxSelections: number | null;
  isActive: boolean;
  optionCount: number;
  activeOptionCount: number;
  // How many products the group is attached to.
  productCount: number;
}

export interface AdminModifierGroupDetail {
  id: string;
  name: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number | null;
  isActive: boolean;
  options: AdminModifierOption[];
  // Every product the group is attached to: an edit here changes them all.
  products: { id: string; name: string; isActive: boolean }[];
}

// POST /api/v1/admin/catalog/modifier-groups. Response 201:
// `AdminModifierGroupDetail` (no options yet).
export interface AdminCreateModifierGroupRequest {
  name: string;
  minSelections: number;
  maxSelections: number | null;
}

// PATCH /api/v1/admin/catalog/modifier-groups/:groupId. Every field is
// optional. Response: `AdminModifierGroupDetail`.
export interface AdminUpdateModifierGroupRequest {
  name?: string;
  minSelections?: number;
  maxSelections?: number | null;
  isActive?: boolean;
}

// POST /api/v1/admin/catalog/modifier-groups/:groupId/options.
// Response 201: `AdminModifierGroupDetail`.
export interface AdminCreateModifierOptionRequest {
  name: string;
  priceAdjustment: number;
}

// PATCH /api/v1/admin/catalog/modifier-groups/:groupId/options/:optionId.
// Response: `AdminModifierGroupDetail`.
export interface AdminUpdateModifierOptionRequest {
  name?: string;
  priceAdjustment?: number;
  isActive?: boolean;
}

// PUT /api/v1/admin/catalog/modifier-groups/:groupId/option-order — every
// option of the group exactly once, in the new order.
export interface AdminReorderModifierOptionsRequest {
  optionIds: string[];
}

// A group as attached to one product, in the product's order.
export interface AdminProductModifierGroup {
  id: string;
  name: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number | null;
  isActive: boolean;
  activeOptionCount: number;
  // How many products share this group (including this one).
  productCount: number;
}

// GET /api/v1/admin/catalog/products/:productId/modifier-groups and the
// response of every product attachment change.
export interface AdminProductModifiersResponse {
  productId: string;
  groups: AdminProductModifierGroup[];
}

// POST /api/v1/admin/catalog/products/:productId/modifier-groups —
// attaches the group at the end. Idempotent when already attached.
export interface AdminAttachModifierGroupRequest {
  modifierGroupId: string;
}

// PUT /api/v1/admin/catalog/products/:productId/modifier-group-order —
// every attached group exactly once, in the new order.
export interface AdminReorderProductModifierGroupsRequest {
  modifierGroupIds: string[];
}

// --- Checkout / orders (Milestone 3, first transaction slice) ----------

export type PaymentAttemptStatus = "PENDING" | "SUCCEEDED" | "DECLINED" | "FAILED";

// RECEIVED is the only status checkout creates. ACCEPTED..COMPLETED are the
// approved Store Queue pipeline. REJECTED (turned away while still RECEIVED)
// and CANCELLED (called off after acceptance) are the two terminal "closed"
// states added in R1 / S5a: nothing writes either yet, so no order is ever in
// one today, but every client must already understand them (an unknown status
// must never read as a failed poll or as a sale). See `@mocha-house/domain`
// for the classification (terminal, and not a commercial sale).
export type OrderStatus =
  | "RECEIVED"
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED";

export interface GuestContactInput {
  name: string;
  phone: string;
  email?: string | null;
}

export interface CheckoutLineSelectionInput {
  groupId: string;
  optionIds: string[];
}

export interface CheckoutLineInput {
  productId: string;
  quantity: number;
  selections: CheckoutLineSelectionInput[];
}

// The client-submitted cart. Note there is no price field anywhere in this
// shape — the backend independently reprices every line and never reads a
// client-submitted amount.
//
// `loyaltyRewardId` (Milestone 7C) is the ONLY loyalty input the client
// sends: the id of the single Mocha Bean reward the signed-in customer
// chose to apply, or null / omitted for no reward. The server loads the
// reward, revalidates it against the current cart and the customer's
// current balance, and computes the discount and Bean cost itself — the
// client's view is never trusted. A guest that submits a `loyaltyRewardId`
// is rejected before any payment.
//
// ESP-03 PR 6 — `checkoutToken` is the server-issued checkout session token
// (POST /api/v1/orders/checkout-sessions). Clients never send a payment key:
// the server generates one for every payment attempt, and every retry with
// the same token is bound to the same checkout. A request that still sends
// `idempotencyKey` is refused (400 CLIENT_PAYMENT_KEY_NOT_ACCEPTED) before
// anything is charged. The web storefront never handles the token in browser
// code: its own server keeps it in an HttpOnly cookie and adds it here.
export interface CheckoutRequest {
  checkoutToken: string;
  locationId: string;
  guest: GuestContactInput;
  lines: CheckoutLineInput[];
  loyaltyRewardId?: string | null;
  // `couponCode` (Milestone 7E) is the code the customer typed into the
  // coupon box, or null / omitted. The server normalizes it (trim +
  // upper-case), resolves the Coupon, revalidates it against the current
  // cart / location / dates / minimum / limits, and computes the discount
  // itself. When a valid coupon is supplied the server does NOT also apply
  // an automatic Promotion; an invalid coupon is rejected before payment
  // (never silently swapped for an automatic Promotion). When omitted, the
  // best eligible automatic Promotion (if any) applies automatically.
  couponCode?: string | null;
  // `giftCardCode` (Milestone 7G) is the gift-card code the customer typed,
  // or null / omitted. A gift card is a TENDER, not a discount: the server
  // resolves it (canonicalize + HMAC hash + lookup), requires it ACTIVE
  // with a matching currency and a positive balance, and applies
  // `min(balance, amount owed after promotion + reward discounts)` against
  // the order — the remainder is charged externally. At most ONE gift card
  // per order. An invalid / inactive / depleted / wrong-currency card is
  // rejected before any payment. Guests may redeem. The plaintext code is
  // only ever sent in this request body — never a URL, query string, order
  // record or response.
  giftCardCode?: string | null;
}

// The immutable snapshot of the one Mocha Bean reward redeemed on an order
// (Milestone 7C). Reused by confirmation, customer history and the store
// order detail. All values are what was true AT REDEMPTION TIME — later HQ
// edits to the reward never change these.
export interface OrderLoyaltyRewardSummary {
  rewardName: string;
  rewardType: LoyaltyRewardType;
  // Mocha Beans deducted (the reward's full configured cost).
  beanCost: number;
  // Discount applied to the gross merchandise subtotal, integer minor units.
  discountMinorUnits: number;
  // FREE_ITEM only — the product one unit of which was made free.
  freeItemName: string | null;
}

// The immutable snapshot of the ONE gift card redeemed as tender on an
// order (Milestone 7G). Reused by confirmation, customer history and the
// store order detail. `last4` is the ONLY code representation ever exposed —
// the plaintext code and codeHash are never returned. `null` for an order
// that used no gift card. A gift card is a tender, not a discount: it does
// not reduce `subtotal` or any discount, and the merchandise basis for
// promotion / Mocha Bean earning is unaffected.
export interface OrderGiftCardSummary {
  // e.g. "4821" — render as "Gift Card •••• 4821".
  last4: string;
  // The amount of the order paid by this gift card, integer minor units.
  amountMinorUnits: number;
}

// --- Order: the regular Promotion / Coupon snapshot (Milestone 7E) ---
// The immutable record of the ONE regular Promotion or Coupon used on an
// order. Reused by confirmation, customer history and the store order
// detail. Every value is what was true AT REDEMPTION TIME — later HQ edits
// never change these. `null` for an order that used no regular discount.
export type PromotionKind = "AUTOMATIC" | "COUPON";
export type PromotionDiscountType =
  | "PERCENTAGE_OFF"
  | "FIXED_AMOUNT"
  | "FREE_ITEM";

export interface OrderPromotionSummary {
  name: string;
  kind: PromotionKind;
  // The normalized code the customer entered — COUPON only, null for an
  // automatic Promotion.
  couponCode: string | null;
  discountType: PromotionDiscountType;
  // The configured value at redemption (percent, or minor units); 0 for
  // FREE_ITEM.
  discountValue: number;
  // The actual monetary discount applied to gross merchandise, minor units.
  discountMinorUnits: number;
  // FREE_ITEM only — the product one unit of which was made free.
  freeItemName: string | null;
}

// The immutable snapshot of the bonus Mocha Beans awarded on an order by one
// or more Bonus Mocha Bean Promotions (Milestone 7D). Reused by
// confirmation, customer history and the store order detail. Every value is
// what was true AT ORDER TIME — later HQ edits to a promotion never change
// these. `null` for an order that earned no bonus.
export interface OrderLoyaltyBonusItemSummary {
  promotionName: string;
  promotionType: LoyaltyBonusPromotionType;
  bonusValue: number;
  productName: string;
  // Paid qualifying units this promotion applied to.
  qualifyingUnits: number;
  bonusBeans: number;
}

export interface OrderLoyaltyBonusSummary {
  totalBonusBeans: number;
  items: OrderLoyaltyBonusItemSummary[];
}

export interface OrderLineSummary {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  selections: {
    groupName: string;
    optionNames: string[];
  }[];
}

// Returned once, at checkout time. accessToken is the guest's bearer
// credential for the status endpoint — the caller must persist it
// (e.g. in the confirmation URL) to view this order again.
//
// Money (Milestone 7C / 7E / 7G):
//   subtotal          — gross merchandise (sum of every line total).
//   promotionDiscount — the regular Promotion/Coupon discount; 0 when none.
//   rewardDiscount    — the Mocha Bean reward discount; 0 when no reward.
//   total             — subtotal - promotionDiscount - rewardDiscount =
//                       the amount owed (paid by gift card + external
//                       payment together).
//   giftCardTenderMinorUnits — of `total`, the part paid by a redeemed gift
//                       card; 0 when none. A TENDER, not a discount.
//   externalPaymentMinorUnits — total - giftCardTenderMinorUnits = the
//                       amount charged to the external payment method.
//   orderPromotion    — the regular discount snapshot, or null.
//   loyaltyReward     — the redeemed reward snapshot, or null.
//   orderGiftCard     — the redeemed gift-card snapshot (last4 + amount), or
//                       null.
// Pre-7E orders read promotionDiscount 0, orderPromotion null; pre-7C orders
// also read rewardDiscount 0, total === subtotal, loyaltyReward null; pre-7G
// orders read giftCardTenderMinorUnits 0, orderGiftCard null,
// externalPaymentMinorUnits === total.
export interface OrderConfirmation {
  orderId: string;
  orderNumber: string;
  accessToken: string;
  status: OrderStatus;
  locationId: string;
  locationName: string;
  guestName: string;
  subtotal: number;
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  currency: string;
  lines: OrderLineSummary[];
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
  createdAt: string;
}

export interface OrderStatusResponse {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentAttemptStatus;
  locationName: string;
  guestName: string;
  subtotal: number;
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  currency: string;
  lines: OrderLineSummary[];
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
  createdAt: string;
}

// Shape of a 402 response body when FakePaymentProvider declines or fails.
// No Order is created for either outcome — the cart is left untouched.
export interface CheckoutDeclinedResponse {
  outcome: "declined" | "failed";
  message: string;
}

// --- Customer identity & sign-in (Milestone 4, customer auth foundation) ---
// Cognito (or the equivalent local/test auth boundary — see apps/api's
// customer-auth module) owns credentials; these shapes never carry a
// password or a Cognito SDK payload, only what the account UI needs.

export type CustomerAccountStatus = "ACTIVE" | "RESTRICTED" | "DEACTIVATED";

export interface CustomerProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  status: CustomerAccountStatus;
  // Whether the identity provider has confirmed this account's email
  // (derived from the Mocha House Customer's emailVerifiedAt — the
  // timestamp itself is never exposed). Read-only here: verification is
  // driven by the Register -> Verify flow, never by a profile update.
  emailVerified: boolean;
  createdAt: string;
}

// SC4f-2 — one CENTERIVO login, a separate profile per business. Each
// business's profile is created only when the customer registers there or
// explicitly joins it; other customer routes refuse with these codes.
export const CUSTOMER_NOT_ENROLLED = "CUSTOMER_NOT_ENROLLED";
export const CUSTOMER_ACCOUNT_RESTRICTED = "CUSTOMER_ACCOUNT_RESTRICTED";
export const CUSTOMER_ACCOUNT_UNAVAILABLE = "CUSTOMER_ACCOUNT_UNAVAILABLE";
export const CUSTOMER_EMAIL_NOT_VERIFIED = "CUSTOMER_EMAIL_NOT_VERIFIED";

// 403 body for CUSTOMER_NOT_ENROLLED. businessName is the RESOLVED business's
// own name (never browser input), for "Join {businessName} …".
export interface CustomerNotEnrolledError {
  statusCode: 403;
  code: typeof CUSTOMER_NOT_ENROLLED;
  message: string;
  businessName: string;
}

// POST /customers/me/enrollment — the customer's explicit choice to join the
// current business. displayName is optional (the login's name otherwise).
export interface CustomerEnrollmentRequest {
  displayName?: string | null;
}

export interface CustomerEnrollmentResponse {
  profile: CustomerProfile;
  // false when this login already had a profile here (returned unchanged).
  created: boolean;
}

// --- Preferred locations & communication preferences (Milestone 4F) ---
// The customer account exists to make repeat ordering faster. A preferred
// location is just a saved reference to an authoritative Location — the
// account never stores location details of its own, and orderability is
// always re-checked live against the menu when an order actually begins.
// Marketing consent is kept entirely separate from transactional email.

// GET/POST/DELETE /customers/me/locations all return the customer's
// current preferred set, reusing LocationSummary. `isDigitalOrderingEnabled`
// is the live orderability signal the account UI shows; it is never frozen
// into preference state.
export type CustomerPreferredLocationsResponse = LocationSummary[];

export interface AddPreferredLocationRequest {
  locationId: string;
}

export interface CustomerCommunicationPreferences {
  // true only when the customer has explicitly opted in to marketing email.
  // Never affects transactional/account mail (verification, password
  // recovery, order confirmation, security notices).
  marketingEmailOptIn: boolean;
}

export interface CustomerUpdateCommunicationPreferencesRequest {
  marketingEmailOptIn: boolean;
}

// --- Customer profile management (Milestone 4E) ------------------------
// The Mocha House Customer record is the authoritative application
// profile. This request carries ONLY the customer-editable fields — never
// email, account status, verification state, or the provider identity
// (externalProvider/externalSubject), which a profile update can never
// change. `displayName: null` explicitly clears the stored name (the
// account UI then falls back to the email); a blank/whitespace-only string
// is normalized to null rather than stored.
export interface CustomerUpdateProfileRequest {
  displayName: string | null;
}

export interface CustomerSignInRequest {
  identifier: string;
  password: string;
}

// idToken is a bearer credential for GET /customers/me (Authorization:
// Bearer <idToken>) — the caller is expected to store it only in an
// httpOnly cookie, never in browser-readable storage.
export interface CustomerSignInResponse {
  idToken: string;
  expiresInSeconds: number;
}

// --- Customer registration & email verification (Milestone 4C) ---------
// Register -> Verify -> Sign In, deliberately kept as three separate
// steps (no session is established by register/verify) — see
// customer-auth's registration provider boundary. Never carries a
// password back, a raw provider payload, or a verification code in a
// response body.

export interface CustomerRegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface CustomerRegisterResponse {
  email: string;
}

export interface CustomerVerifyRequest {
  email: string;
  code: string;
}

export interface CustomerVerifyResponse {
  email: string;
}

export interface CustomerResendVerificationRequest {
  email: string;
}

export interface CustomerResendVerificationResponse {
  email: string;
}

// --- Customer password recovery & reset (Milestone 4D) -----------------
// Forgot Password -> Reset Password, mirroring Register -> Verify: two
// separate steps, no session established by either. The identity provider
// (Cognito, or its local/test stand-in) owns the recovery code and the
// password — these shapes never carry a code, a password, a raw provider
// payload, or an auth token. A successful reset ends at Sign In; the
// customer is never auto-authenticated.

export interface CustomerForgotPasswordRequest {
  email: string;
}

// Deliberately just a fixed, neutral acknowledgement — the same text
// whether or not an account exists for that email, so the response cannot
// be used to enumerate registered accounts. A genuine provider outage is
// still surfaced as an error status, not masked as this success.
export interface CustomerForgotPasswordResponse {
  message: string;
}

export interface CustomerResetPasswordRequest {
  email: string;
  code: string;
  newPassword: string;
}

export interface CustomerResetPasswordResponse {
  email: string;
}

// --- Customer order history (Milestone 4B) ------------------------------
// Read-only, authenticated views over the same authoritative Order records
// guest confirmation/tracking already uses (see OrderConfirmation /
// OrderStatusResponse above) — never a separate/parallel order record.
// Deliberately reuses OrderStatus and OrderLineSummary rather than
// duplicating them. These are historical snapshots: nothing here is
// re-derived from the live catalog or from the Customer's current profile.

export interface CustomerOrderSummary {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  locationName: string;
  status: OrderStatus;
  // subtotal = gross merchandise;
  // total = subtotal - promotionDiscount - rewardDiscount (Milestone 7C / 7E)
  //   = the amount owed (paid by gift card + external payment together).
  // Pre-7E orders: promotionDiscount 0; pre-7C orders: rewardDiscount 0;
  // pre-7G orders: giftCardTenderMinorUnits 0, externalPaymentMinorUnits
  // === total.
  subtotal: number;
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  // Milestone 7G — the tender split of `total`.
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  currency: string;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  lines: OrderLineSummary[];
  // Milestone 7E — the regular Promotion/Coupon snapshot, or null.
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
}

// --- Loyalty: Mocha Beans balance + rewards (Milestone 7A; rewards 7B) --
// "Mocha Beans" is the official customer-facing loyalty currency.
// Customer-facing Bean history is deliberately NOT exposed (it is an
// HQ-controlled setting that defaults off and ships in a later slice).
//
// GET /api/v1/customers/me/loyalty (CustomerAuthGuard). The balance is a
// whole non-negative integer number of Mocha Beans. `rewards` (Milestone
// 7B) is the customer-facing Rewards Catalog: the currently ACTIVE rewards
// only, in HQ display order. Redemption is NOT part of 7B — nothing here
// lets a customer select, reserve or apply a reward, and no Beans move.
export type LoyaltyRewardType = "FIXED_AMOUNT" | "FREE_ITEM";

export interface CustomerLoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  type: LoyaltyRewardType;
  // Whole Mocha Beans the customer would spend to redeem this (in a future
  // slice). Shown for information only in 7B.
  beanCost: number;
  // FIXED_AMOUNT only — the dollar-off value in integer minor units (cents).
  // Null for FREE_ITEM.
  fixedAmountMinorUnits: number | null;
  // FREE_ITEM only — display names of the eligible products/categories.
  // Empty for FIXED_AMOUNT.
  eligibleItemNames: string[];
  // Whether the customer's current balance is >= beanCost. Purely
  // informational; it reserves nothing and deducts nothing.
  canAfford: boolean;
}

export interface CustomerLoyaltySummary {
  balance: number;
  rewards: CustomerLoyaltyReward[];
  // SC2b — false when the business's plan does not include loyalty: the
  // balance is kept and shown, but nothing is earned or redeemed (and
  // rewards is empty) until loyalty is available again.
  available: boolean;
}

// --- Checkout: Mocha Bean reward eligibility (Milestone 7C) ----------
// POST /api/v1/orders/reward-eligibility (CustomerAuthGuard — signed-in
// customers only; a guest gets no rewards). A read-only quote: given the
// current cart it returns the ACTIVE rewards that are actually eligible for
// THIS cart, each with the discount it would apply and whether the customer
// can currently afford it. It reserves nothing and deducts nothing. The
// checkout submission independently revalidates everything.
export interface CheckoutRewardEligibilityRequest {
  locationId: string;
  lines: CheckoutLineInput[];
}

export interface CheckoutRewardOption {
  rewardId: string;
  name: string;
  description: string | null;
  type: LoyaltyRewardType;
  beanCost: number;
  // The discount this reward would apply to the current cart, integer minor
  // units (server-computed, authoritative).
  discountMinorUnits: number;
  // FREE_ITEM only — the item that would be made free (lowest-priced
  // eligible unit in the current cart).
  freeItemName: string | null;
  // balance >= beanCost right now. Informational; the checkout submission
  // re-checks under a row lock.
  canAfford: boolean;
}

export interface CheckoutRewardEligibilityResponse {
  balance: number;
  rewards: CheckoutRewardOption[];
  // SC2b — false when loyalty is not in the business's plan (rewards empty).
  available: boolean;
}

// --- Checkout: the unified pricing quote (Milestone 7E) -------------
// POST /api/v1/orders/checkout-quote (OptionalCustomerAuthGuard — guests
// allowed; they just get no rewards and cannot use a per-customer-limited
// coupon). The ONE server-authoritative pricing preview the checkout screen
// renders: given the cart, an optional coupon code, and an optional
// selected reward id, it returns the regular Promotion/Coupon discount, the
// eligible Mocha Bean rewards, and the resulting total. It reserves
// nothing, consumes no redemption, and deducts no Beans; the checkout
// submission independently revalidates everything.
export interface CheckoutQuoteRequest {
  locationId: string;
  lines: CheckoutLineInput[];
  // The code the customer typed, or null/omitted. Normalized server-side.
  couponCode?: string | null;
  // The reward the customer currently has selected, or null/omitted.
  loyaltyRewardId?: string | null;
  // Milestone 7G — the gift-card code the customer applied, or null/omitted.
  // Resolved READ-ONLY: the quote validates the card and reports how much it
  // would apply, but reserves and decrements nothing. Never put this in a
  // URL / query string.
  giftCardCode?: string | null;
}

// Why a supplied coupon code did or didn't apply. `null` when no code was
// supplied (the response then carries the best automatic Promotion, if any).
export type CouponQuoteStatus =
  | "applied"
  | "invalid"
  | "inactive"
  | "not_started"
  | "expired"
  | "wrong_location"
  | "not_applicable"
  | "minimum_not_met"
  | "usage_limit_reached"
  | "sign_in_required"
  // SC2b — the business's plan does not include promotions.
  | "not_available";

export interface CheckoutQuoteRegularDiscount {
  // COUPON when it came from a customer-entered code; AUTOMATIC when it is
  // the best eligible automatic Promotion.
  source: PromotionKind;
  name: string;
  discountType: PromotionDiscountType;
  // Server-computed, authoritative.
  discountMinorUnits: number;
  // FREE_ITEM only — the item that would be made free.
  freeItemName: string | null;
}

// Milestone 7G — why a supplied gift-card code did or didn't apply on the
// quote. `null` when no code was supplied.
export type GiftCardQuoteStatus =
  | "applied"
  | "not_found"
  | "inactive"
  | "no_balance"
  | "currency_mismatch";

// Milestone 7G — the read-only gift-card preview on the checkout quote.
// Present only when `giftCardCode` was supplied AND it resolved to a usable
// card (`giftCardStatus === "applied"`). Reserves and decrements nothing.
export interface CheckoutQuoteGiftCard {
  // The ONLY code representation — render as "Gift Card •••• 4821".
  last4: string;
  // The card's current balance, integer minor units (informational).
  availableBalanceMinorUnits: number;
  // min(availableBalance, amount owed after promotion + reward discounts).
  appliedMinorUnits: number;
}

export interface CheckoutQuoteResponse {
  currency: string;
  // Gross merchandise (sum of every priced line total).
  subtotal: number;
  // The regular discount that WOULD apply: the supplied coupon if valid,
  // otherwise the best automatic Promotion, otherwise null.
  regularDiscount: CheckoutQuoteRegularDiscount | null;
  // Present only when a coupon code was supplied — why it did / didn't apply.
  couponStatus: CouponQuoteStatus | null;
  couponMessage: string | null;
  // Signed-in customers only (0 / empty for a guest). The rewards are
  // computed against the merchandise remaining AFTER the regular discount.
  balance: number;
  rewards: CheckoutRewardOption[];
  // The discount the currently-selected `loyaltyRewardId` would apply (0
  // when none selected or it no longer applies).
  rewardDiscountMinorUnits: number;
  // subtotal - regularDiscount - rewardDiscountMinorUnits = the amount owed.
  total: number;
  // Milestone 7G — present only when a gift-card code was supplied; why it
  // did / didn't apply.
  giftCardStatus: GiftCardQuoteStatus | null;
  giftCardMessage: string | null;
  // The usable gift-card preview, or null (no code supplied, or it did not
  // resolve to a usable card).
  giftCard: CheckoutQuoteGiftCard | null;
  // total - (giftCard?.appliedMinorUnits ?? 0) = what the customer would pay
  // by external payment. Equals `total` when no gift card applies.
  amountDueAfterGiftCardMinorUnits: number;
  // SC2b — whether this business currently offers loyalty rewards and
  // promotions/coupons. Gift-card redemption is always available (existing
  // cards are stored value the business owes).
  loyaltyAvailable: boolean;
  promotionsAvailable: boolean;
}

// --- Admin: HQ loyalty configuration (Milestone 7B) ------------------
// GET/PUT /api/v1/admin/loyalty/settings (InternalAuthGuard +
// PermissionGuard + `loyalty.configure`, CORPORATE-only). The standard
// company-wide Mocha Bean earning rate — a whole number of Beans per whole
// qualifying dollar. Never per-location, per-segment or time-based.
export interface LoyaltySettings {
  earningRatePerDollar: number;
}

// `earningRatePerDollar` must be a whole integer, 1-100. Changing it
// affects only FUTURE earning; historical EARN ledger entries and balances
// are never recalculated.
export interface UpdateLoyaltySettingsRequest {
  earningRatePerDollar: number;
}

// --- Admin: Rewards Catalog (Milestone 7B) --------------------------
// GET/POST/PATCH /api/v1/admin/loyalty/rewards[...] (`loyalty.configure`,
// CORPORATE-only). Catalog management only — no redemption. Rewards are
// never hard-deleted; `isActive` is the off switch.

export interface AdminLoyaltyRewardCatalogRef {
  id: string;
  name: string;
}

export interface AdminLoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  type: LoyaltyRewardType;
  beanCost: number;
  fixedAmountMinorUnits: number | null;
  isActive: boolean;
  sortOrder: number;
  // FREE_ITEM eligibility. Empty for FIXED_AMOUNT.
  eligibleProducts: AdminLoyaltyRewardCatalogRef[];
  eligibleCategories: AdminLoyaltyRewardCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoyaltyRewardsResponse {
  rewards: AdminLoyaltyReward[];
}

// GET /api/v1/admin/loyalty/catalog-options (`loyalty.configure`). The
// product/category picker data for building a FREE_ITEM reward — identity
// and name only, so managing rewards never requires `catalog.view`.
export interface AdminLoyaltyCatalogOptions {
  products: AdminLoyaltyRewardCatalogRef[];
  categories: AdminLoyaltyRewardCatalogRef[];
}

// `type` is required and fixed at creation (never editable). For
// FIXED_AMOUNT: `fixedAmountMinorUnits` (> 0, integer cents) is required
// and eligibility lists must be absent/empty. For FREE_ITEM:
// `fixedAmountMinorUnits` must be absent and there must be >= 1 eligible
// product or category, all referencing existing catalog ids.
export interface CreateLoyaltyRewardRequest {
  name: string;
  description?: string | null;
  type: LoyaltyRewardType;
  beanCost: number;
  fixedAmountMinorUnits?: number | null;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
  sortOrder?: number;
}

// Every field optional — only present fields change. `type` is NOT
// accepted. Providing `eligibleProductIds`/`eligibleCategoryIds` REPLACES
// that list wholesale (FREE_ITEM only). `isActive` toggles activation.
export interface UpdateLoyaltyRewardRequest {
  name?: string;
  description?: string | null;
  beanCost?: number;
  fixedAmountMinorUnits?: number | null;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

// --- Admin: Bonus Mocha Beans Promotions (Milestone 7D) -------------
// GET/POST/PATCH /api/v1/admin/loyalty/bonus-promotions[...]
// (`loyalty.configure`, CORPORATE-only). Deliberately simple product-based
// Bean bonus campaigns — NOT a generic promotion/rules engine. Promotions
// are never hard-deleted; `isActive` is the off switch. A promotion never
// discounts money — it only awards extra Mocha Beans on qualifying items.
export type LoyaltyBonusPromotionType = "EXTRA_BEANS" | "MULTIPLIER";

export interface AdminLoyaltyBonusPromotion {
  id: string;
  name: string;
  type: LoyaltyBonusPromotionType;
  // EXTRA_BEANS: whole Beans per qualifying paid unit (1..100000).
  // MULTIPLIER: whole multiple of standard item earning (2..10).
  bonusValue: number;
  isActive: boolean;
  // ISO 8601, or null for "no bound".
  startsAt: string | null;
  endsAt: string | null;
  appliesToAllLocations: boolean;
  eligibleProducts: AdminLoyaltyRewardCatalogRef[];
  // Empty when appliesToAllLocations is true.
  eligibleLocations: AdminLoyaltyRewardCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoyaltyBonusPromotionsResponse {
  promotions: AdminLoyaltyBonusPromotion[];
}

// GET /api/v1/admin/loyalty/bonus-promotion-options (`loyalty.configure`).
// The product + location picker data for building a promotion — identity
// and name only, so managing promotions never requires `catalog.view` or
// `locations.view`.
export interface AdminLoyaltyBonusPromotionOptions {
  products: AdminLoyaltyRewardCatalogRef[];
  locations: AdminLoyaltyRewardCatalogRef[];
}

// `type` is required and fixed at creation (never editable). `bonusValue`
// range depends on `type` (see above). At least one `eligibleProductId` is
// required. Location targeting is `appliesToAllLocations: true` OR at least
// one `eligibleLocationId`. If both `startsAt` and `endsAt` are given,
// `endsAt` must be after `startsAt`.
export interface CreateLoyaltyBonusPromotionRequest {
  name: string;
  type: LoyaltyBonusPromotionType;
  bonusValue: number;
  eligibleProductIds: string[];
  appliesToAllLocations?: boolean;
  eligibleLocationIds?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
}

// Every field optional — only present fields change. `type` is NOT
// accepted. Providing `eligibleProductIds` / `eligibleLocationIds` REPLACES
// that list wholesale. `isActive` toggles activation.
export interface UpdateLoyaltyBonusPromotionRequest {
  name?: string;
  bonusValue?: number;
  eligibleProductIds?: string[];
  appliesToAllLocations?: boolean;
  eligibleLocationIds?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

// --- Admin: Promotions & Coupons (Milestone 7E) --------------------
// GET/POST/PATCH /api/v1/admin/promotions[...] (InternalAuthGuard +
// PermissionGuard + `promotions.configure`, CORPORATE-only). The platform's
// regular merchandise-discount system, entirely separate from Mocha Bean
// rewards and Bonus Mocha Bean Promotions. Promotions are never
// hard-deleted; `isActive` is the off switch. `PromotionKind` /
// `PromotionDiscountType` are declared with the order snapshot above.
export type PromotionApplicability =
  | "ENTIRE_ORDER"
  | "SELECTED_PRODUCTS"
  | "SELECTED_CATEGORIES";

export interface AdminPromotionCatalogRef {
  id: string;
  name: string;
}

export interface AdminPromotion {
  id: string;
  name: string;
  description: string | null;
  kind: PromotionKind;
  // Normalized (upper-cased) code — COUPON only, null for AUTOMATIC.
  code: string | null;
  discountType: PromotionDiscountType;
  // PERCENTAGE_OFF: whole percent 1..100. FIXED_AMOUNT: minor units.
  // FREE_ITEM: 0.
  discountValue: number;
  // PERCENTAGE_OFF only — the optional cap on the resulting discount.
  maxDiscountMinorUnits: number | null;
  applicability: PromotionApplicability;
  minimumSubtotalMinorUnits: number | null;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  appliesToAllLocations: boolean;
  totalRedemptionLimit: number | null;
  perCustomerRedemptionLimit: number | null;
  // Persisted successful redemptions so far (informational).
  redemptionCount: number;
  // Empty unless applicability is SELECTED_PRODUCTS / SELECTED_CATEGORIES
  // (products) or a FREE_ITEM promotion.
  eligibleProducts: AdminPromotionCatalogRef[];
  eligibleCategories: AdminPromotionCatalogRef[];
  // Empty when appliesToAllLocations is true.
  eligibleLocations: AdminPromotionCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminPromotionsResponse {
  promotions: AdminPromotion[];
}

// GET /api/v1/admin/promotions/options (`promotions.configure`). Product,
// category and location picker data — identity and name only.
export interface AdminPromotionOptions {
  products: AdminPromotionCatalogRef[];
  categories: AdminPromotionCatalogRef[];
  locations: AdminPromotionCatalogRef[];
}

// `kind` and `discountType` are required and fixed at creation. `code` is
// required for a COUPON and must be absent for an AUTOMATIC promotion.
// PERCENTAGE_OFF: `discountValue` 1..100. FIXED_AMOUNT: `discountValue` a
// positive minor-unit amount. FREE_ITEM / SELECTED_* : at least one
// eligible product or category. Location targeting: `appliesToAllLocations`
// OR at least one `eligibleLocationId`. Dates: `endsAt` after `startsAt`
// when both are present.
export interface CreatePromotionRequest {
  name: string;
  description?: string | null;
  kind: PromotionKind;
  code?: string | null;
  discountType: PromotionDiscountType;
  discountValue?: number;
  maxDiscountMinorUnits?: number | null;
  applicability?: PromotionApplicability;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
  minimumSubtotalMinorUnits?: number | null;
  appliesToAllLocations?: boolean;
  eligibleLocationIds?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  totalRedemptionLimit?: number | null;
  perCustomerRedemptionLimit?: number | null;
}

// Every field optional — only present fields change. `kind` and
// `discountType` are NOT accepted (fixed at creation). Providing an
// eligibility / location list REPLACES it wholesale. `isActive` toggles
// activation.
export interface UpdatePromotionRequest {
  name?: string;
  description?: string | null;
  code?: string | null;
  discountValue?: number;
  maxDiscountMinorUnits?: number | null;
  applicability?: PromotionApplicability;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
  minimumSubtotalMinorUnits?: number | null;
  appliesToAllLocations?: boolean;
  eligibleLocationIds?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  totalRedemptionLimit?: number | null;
  perCustomerRedemptionLimit?: number | null;
  isActive?: boolean;
}

// --- Reorder from order history (Milestone 4G) -------------------------
// The historical Order is a snapshot/reference only. A reorder is ALWAYS
// revalidated against the current location, menu, product availability,
// modifier structure, and pricing before any cart is rebuilt — no
// checkout request is ever constructed from stored historical prices or
// availability. The prepare endpoint mutates nothing (no Order, no
// PaymentAttempt); the web layer converts the validated result into the
// existing cart representation, and checkout still performs its own final
// authoritative validation.

// Machine-readable so the UI can branch reliably; the human-facing
// `message` on each ReorderIssue is mapped deliberately, never a raw
// backend/Prisma error.
export type ReorderIssueCode =
  | "LOCATION_INACTIVE"
  | "LOCATION_DIGITAL_ORDERING_DISABLED"
  | "PRODUCT_NOT_ON_MENU"
  | "PRODUCT_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "MODIFIER_GROUP_REMOVED"
  | "MODIFIER_OPTION_REMOVED"
  | "MODIFIER_REQUIRED_SELECTION_MISSING"
  | "MODIFIER_SELECTION_COUNT_INVALID";

export interface ReorderIssue {
  code: ReorderIssueCode;
  message: string;
  productName?: string;
}

// VALID   — restores exactly, nothing material changed.
// CHANGED — still reorderable, but the customer must see what changed
//           (price moved, an optional modifier disappeared, a now-required
//           choice is missing, min/max no longer satisfied). When
//           `needsCustomization` is true the item must be opened in the
//           normal product customizer before checkout.
// UNAVAILABLE — cannot be automatically restored (product gone from the
//           menu / unavailable). Never silently substituted.
export type ReorderItemStatus = "VALID" | "CHANGED" | "UNAVAILABLE";

export interface ReorderPreparedSelection {
  groupId: string;
  groupName: string;
  optionIds: string[];
  optionNames: string[];
}

export interface ReorderPreparedItem {
  status: ReorderItemStatus;
  productId: string;
  // Current product name (historical name is intentionally not surfaced
  // separately — the current catalog is authoritative for display too).
  productName: string;
  quantity: number;
  currency: string;
  historicalUnitPrice: number;
  // Present unless status is UNAVAILABLE.
  currentUnitPrice?: number;
  currentLineSubtotal?: number;
  // The current, resolved modifier selections (historical option ids that
  // no longer resolve are dropped and reported as issues, never guessed).
  selections: ReorderPreparedSelection[];
  needsCustomization: boolean;
  issues: ReorderIssue[];
}

// READY       — every item is VALID; a fast rebuild is safe.
// NEEDS_REVIEW — at least one item changed or is unavailable, but >=1 item
//               can still be restored. The customer reviews, then confirms.
// UNAVAILABLE  — nothing can be restored (location not orderable, or every
//               item unavailable).
export type ReorderPreparationStatus = "READY" | "NEEDS_REVIEW" | "UNAVAILABLE";

export interface ReorderPreparation {
  orderId: string;
  location: LocationSummary;
  // The current active menu id for the location — present unless the
  // location is UNAVAILABLE. The web layer stamps it onto rebuilt cart
  // lines; cart/checkout revalidation is still by location.
  menuId?: string;
  status: ReorderPreparationStatus;
  items: ReorderPreparedItem[];
  // Order-level issues (currently only location problems).
  issues: ReorderIssue[];
  historicalTotal: number;
  // Sum of currentLineSubtotal across restorable (VALID/CHANGED) items.
  currentEstimatedSubtotal: number;
}

// --- Store Queue / operational lifecycle (Milestone 3, next slice) -----
// As of Milestone 5A every /api/v1/admin/* route (this one included) is
// protected by InternalAuthGuard — a valid internal identity mapped to an
// ACTIVE Mocha House InternalUser. There is still no role/permission/scope
// model (Milestone 5B). Deliberately excludes guest accessToken and
// guestEmail — staff never need the guest's own bearer credential, and
// email isn't operationally necessary at the counter.

// Rich enough to work a kitchen/counter queue from directly, without a
// click-through to the detail view for every order.
export interface StoreOrderSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  guestName: string;
  subtotal: number;
  currency: string;
  lines: OrderLineSummary[];
}

export interface StoreOrderDetail extends StoreOrderSummary {
  guestPhone: string;
  // Milestone 7E / 7C — the regular Promotion/Coupon and Mocha Bean reward
  // snapshots and the resulting discounts, so staff can see the order's true
  // owed total. Null / 0 when the corresponding discount was not used.
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  // Milestone 7G — the tender split of `total` (0 / null when no gift card).
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null, so
  // staff/HQ can explain the order's Bean accounting.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
  // R1 / S5b — how a REJECTED / CANCELLED order was closed; null for every
  // other order. Staff-only: the internal note never appears in any customer
  // response.
  closure: StoreOrderClosureSummary | null;
}

// --- Order rejection and cancellation (R1 / S5b) -------------------------
// REJECTED: the shop turns away an order it has not accepted (RECEIVED only).
// CANCELLED: the shop calls off an order it already accepted (ACCEPTED,
// PREPARING or READY). Both are terminal. Closing an order reverses what the
// order consumed — the gift-card tender is restored to the card, redeemed
// Mocha Beans are returned, earned Beans are recovered (any part the customer
// already spent is recorded as a shortfall), promotion usage is released — and
// the card-paid amount becomes a refund OBLIGATION that stays DUE until a
// person records a refund. Nothing here moves money on a card.

// Machine reason codes (UPPER_SNAKE, stored on OrderClosure.reasonCode). The
// staff-facing wording lives in ORDER_CLOSURE_REASON_LABELS. OTHER requires a
// note.
export const ORDER_REJECTION_REASON_CODES = [
  "ITEM_UNAVAILABLE",
  "STORE_TOO_BUSY",
  "STORE_CLOSING",
  "DUPLICATE_ORDER",
  "SUSPECTED_FRAUD",
  "OTHER",
] as const;
export type OrderRejectionReasonCode =
  (typeof ORDER_REJECTION_REASON_CODES)[number];

export const ORDER_CANCELLATION_REASON_CODES = [
  "CUSTOMER_REQUEST",
  "ITEM_UNAVAILABLE",
  "EQUIPMENT_FAILURE",
  "STORE_CLOSING",
  "DUPLICATE_ORDER",
  "SUSPECTED_FRAUD",
  "OTHER",
] as const;
export type OrderCancellationReasonCode =
  (typeof ORDER_CANCELLATION_REASON_CODES)[number];

export type OrderClosureReasonCode =
  | OrderRejectionReasonCode
  | OrderCancellationReasonCode;

export const ORDER_CLOSURE_REASON_LABELS: Record<
  OrderClosureReasonCode,
  string
> = {
  ITEM_UNAVAILABLE: "An item is unavailable",
  STORE_TOO_BUSY: "The store is too busy",
  STORE_CLOSING: "The store is closing",
  DUPLICATE_ORDER: "Duplicate order",
  SUSPECTED_FRAUD: "Suspected fraud",
  CUSTOMER_REQUEST: "The customer asked to cancel",
  EQUIPMENT_FAILURE: "Equipment failure",
  OTHER: "Other (see note)",
};

// The longest internal staff note accepted (matches the database CHECK).
export const ORDER_CLOSURE_NOTE_MAX_LENGTH = 500;

export type OrderClosureKind = "REJECTED" | "CANCELLED";

// DUE until a person records an out-of-band refund; PROCESSING / FAILED are
// reserved for a future processor integration. REFUNDED is never set
// automatically.
export type OrderRefundObligationStatus =
  | "DUE"
  | "PROCESSING"
  | "REFUNDED"
  | "FAILED";

export interface StoreOrderClosureSummary {
  kind: OrderClosureKind;
  fromStatus: OrderStatus;
  reasonCode: string;
  reasonLabel: string;
  // Internal staff note, or null. Staff-only.
  note: string | null;
  closedAt: string;
  // Integer minor units owed back on the card payment (0 when nothing was
  // charged to a card).
  refundDueMinorUnits: number;
  // Status of that card refund, or null when nothing is owed.
  refundStatus: OrderRefundObligationStatus | null;
  // Gift-card tender restored to the card, integer minor units.
  giftCardRestoredMinorUnits: number;
  // Earned Mocha Beans that could not be recovered because the customer had
  // already spent them.
  loyaltyShortfallBeans: number;
}

export interface RejectOrderRequest {
  locationId: string;
  reasonCode: OrderRejectionReasonCode;
  // Optional internal note (1-500 characters after trimming). Required when
  // reasonCode is OTHER. Never shown to the customer.
  note?: string | null;
}

export interface CancelOrderRequest {
  locationId: string;
  // Optimistic-concurrency guard: the status the staff member saw (ACCEPTED,
  // PREPARING or READY). If the order has moved since, the request is
  // refused with 409 and nothing changes.
  expectedStatus: OrderStatus;
  reasonCode: OrderCancellationReasonCode;
  note?: string | null;
}

export interface CloseOrderResponse {
  orderId: string;
  status: OrderStatus;
  // false when the order was already closed the same way (an idempotent
  // replay): nothing was reversed or written a second time.
  closed: boolean;
  closure: StoreOrderClosureSummary;
}

export interface AdvanceOrderStatusRequest {
  locationId: string;
  // Optimistic-concurrency guard, not a target status — the server always
  // advances exactly one step from whatever the order's current status
  // actually is. A stale expectedStatus (someone else already advanced it)
  // is how a retry is told apart from a real conflict.
  expectedStatus: OrderStatus;
}

export interface AdvanceOrderStatusResponse {
  orderId: string;
  status: OrderStatus;
  // false when this call found the order already at the target status
  // (an idempotent replay of a retried request) rather than performing the
  // transition itself.
  advanced: boolean;
}

// --- Internal identity & admin authentication (Milestone 5A) -----------
// A SEPARATE security boundary from customer authentication. These shapes
// share nothing with CustomerProfile / CustomerSignInResponse and must
// never be substituted for them. The production internal identity provider
// is a dedicated Cognito user pool + app client (distinct from the customer
// pool); a fail-closed local-dev provider stands in when no pool is
// provisioned. Mocha House remains authoritative for the InternalUser
// record, its lifecycle status, and (from Milestone 5B) its permissions
// and scope — none of which live here yet.
//
// CRITICAL: a valid internal identity token proves identity only. Internal/
// Admin access is granted solely when the identity maps to an existing
// Mocha House InternalUser whose status is ACTIVE. INVITED, SUSPENDED and
// DISABLED are all denied even with an otherwise-valid token, and an
// unknown identity is never provisioned just-in-time.
export type InternalUserStatus =
  | "INVITED"
  | "ACTIVE"
  | "SUSPENDED"
  | "DISABLED";

export interface InternalSignInRequest {
  identifier: string;
  password: string;
}

// idToken is a bearer credential for the internal boundary only
// (Authorization: Bearer <idToken> against /api/v1/internal/* and
// /api/v1/admin/*). It is expected to be stored only in the HttpOnly
// `mh_internal_session` cookie, never in browser-readable storage, and is
// never interchangeable with a customer session token.
export interface InternalSignInResponse {
  idToken: string;
  expiresInSeconds: number;
}

// SC4a — business owner self-service registration
// (/api/v1/internal/registration/*). Off unless the deployment enables it;
// the server is the only authority on that.
export type OwnerRegistrationAvailability =
  | { enabled: false }
  | {
      enabled: true;
      termsVersion: string;
      privacyVersion: string;
      termsUrl: string | null;
      privacyUrl: string | null;
    };

// Step 1: send a code to the email. The answer is the same whether or not
// the email is known, registered or eligible (no account enumeration).
export interface OwnerRegistrationStartRequest {
  email: string;
}

export interface OwnerRegistrationStartResponse {
  status: "CODE_SENT_IF_ELIGIBLE";
}

// Step 2: prove the mailbox with the code, choose the password, accept the
// Terms and Privacy Policy versions shown.
export interface OwnerRegistrationCompleteRequest {
  email: string;
  code: string;
  password: string;
  displayName: string;
  termsVersion: string;
  privacyVersion: string;
  acceptLegal: boolean;
}

export interface OwnerRegistrationCompleteResponse {
  status: "VERIFIED";
}

// Refusal codes (400 unless noted). One code for every code problem, so an
// answer never says whether the email has a registration.
export const OWNER_REGISTRATION_CODE_INVALID = "REGISTRATION_CODE_INVALID";
export const OWNER_REGISTRATION_INVALID_INPUT = "REGISTRATION_INVALID_INPUT";
export const OWNER_REGISTRATION_WEAK_PASSWORD = "REGISTRATION_WEAK_PASSWORD";
// 409 — the Terms or Privacy Policy changed since the page was loaded.
export const OWNER_REGISTRATION_LEGAL_OUTDATED = "REGISTRATION_LEGAL_OUTDATED";
// 503 — the registration quota is used up for now.
export const OWNER_REGISTRATION_UNAVAILABLE = "REGISTRATION_UNAVAILABLE";

// SC4b — a verified, self-registered owner creates their business
// (/api/v1/internal/onboarding*). Only with the restricted onboarding
// session (the owner's own login, no business yet); never tenant admin or
// platform access. Off unless self-service registration is enabled.
export interface OwnerOnboardingPlanPrice {
  planPriceId: string;
  interval: PlatformBillingInterval;
  currency: string;
  amountMinorUnits: number;
}

export interface OwnerOnboardingPlanOption {
  planId: string;
  // The exact published version offered (and stored when chosen).
  planVersionId: string;
  name: string;
  description: string | null;
  modules: SubscriptionModuleKey[];
  prices: OwnerOnboardingPlanPrice[];
}

export type OwnerOnboardingStatus =
  | {
      status: "BUSINESS_REQUIRED";
      ownerName: string;
      email: string;
      plans: OwnerOnboardingPlanOption[];
    }
  | {
      status: "BUSINESS_CREATED";
      business: { id: string; name: string };
    };

// The price the owner saw is sent back; the server refuses (409) rather than
// store a different plan version, price, amount, currency or interval.
export interface OwnerBusinessCreateRequest {
  businessName: string;
  planVersionId: string;
  planPriceId: string;
  expectedPrice: {
    interval: PlatformBillingInterval;
    currency: string;
    amountMinorUnits: number;
  };
}

export interface OwnerBusinessCreateResponse {
  business: { id: string; name: string; slug: string };
  // True when this owner's business already existed (a retry): nothing new.
  replayed: boolean;
}

// 403 — not a verified self-registered owner (or registration is off: 404).
export const ONBOARDING_NOT_ELIGIBLE = "ONBOARDING_NOT_ELIGIBLE";
// 409 — the plan or price is not offered (any more), or differs from what
// the owner saw.
export const ONBOARDING_PLAN_UNAVAILABLE = "ONBOARDING_PLAN_UNAVAILABLE";
export const ONBOARDING_PRICE_CHANGED = "ONBOARDING_PRICE_CHANGED";

// The mapped InternalUser for the authenticated internal identity. Only
// ever returned for an ACTIVE user (the guard rejects every other state
// before the controller runs), so `status` is always "ACTIVE" here; it is
// included for symmetry and forward compatibility, not as a branch the
// caller must handle.
export interface InternalUserProfile {
  id: string;
  email: string;
  displayName: string | null;
  status: InternalUserStatus;
}

// The scope at which a single permission is EFFECTIVE for the user.
//   corporate  — the permission applies at every location (a CORPORATE
//                grant). When true, `locationIds` need not be consulted.
//   locationIds — the specific active Location ids the permission is held
//                at through LOCATION grants. Empty when the permission is
//                only held corporately.
// A permission appears in `capabilities` only if it is effective (held
// through a scope type the permission actually allows — a CORPORATE-only
// permission held only via LOCATION scope never appears, exactly as 5B
// enforcement rejects it).
export interface InternalPermissionCapability {
  corporate: boolean;
  locationIds: string[];
}

// The minimum authorization summary the Admin shell needs to render a
// personalized workspace (Milestone 5C). It is a DERIVED, read-only view of
// the 5B authorization model — never the model itself. It deliberately
// exposes NO role names/keys/ids, NO assignment ids, and NO raw scope rows;
// the backend remains the sole authorization authority and every Admin API
// call is still guarded server-side regardless of what the shell renders.
//
//   capabilities — per effective permission, the scope it is effective at
//                  (see InternalPermissionCapability). This is the
//                  authoritative "does the user hold X, and where" source
//                  for the shell — components must not infer a permission's
//                  scope from `locations` below. Empty object for a user
//                  with no role assignments.
//   permissions  — Object.keys(capabilities); a flat convenience view for
//                  simple "holds X anywhere" checks (e.g. nav visibility).
//   isCorporate  — the user holds at least one CORPORATE-scoped grant of
//                  ANY permission; drives whether the shell offers a
//                  "Corporate / All locations" context. Not a per-permission
//                  signal — use capabilities[key].corporate for that.
//   locations    — the ACTIVE locations the user may operate on at all
//                  (the union across every LOCATION grant, plus every
//                  active location when isCorporate). This is the general
//                  location-selector set, NOT a per-permission scope.
export interface InternalAuthorizationSummary {
  permissions: InternalPermissionKey[];
  isCorporate: boolean;
  locations: LocationSummary[];
  capabilities: Partial<
    Record<InternalPermissionKey, InternalPermissionCapability>
  >;
}

// Milestone S0F — a business (tenant) an internal user may operate in.
// Safe display fields only: no status internals, no configuration, nothing
// about any other tenant.
// SC3c-1 — how this person may use the business right now. FULL: normal.
// BILLING_WIND_DOWN: the business is suspended for billing; only the
// operational wind-down (accepted orders, refunds/reversals through the
// existing safeguards, billing) is available — everything else answers 403
// BUSINESS_BILLING_SUSPENDED.
export type InternalBusinessAccess = "FULL" | "BILLING_WIND_DOWN";
export const BUSINESS_BILLING_SUSPENDED = "BUSINESS_BILLING_SUSPENDED";

export interface InternalBusinessSummary {
  id: string;
  name: string;
  slug: string;
  access: InternalBusinessAccess;
}

// GET /api/v1/internal/businesses (Milestone S0F) — the businesses the
// authenticated internal human may enter (ACTIVE membership in an ACTIVE
// business), for the Business switcher. Requires only a valid internal
// token; no business needs to be active yet. The chosen id is then sent as
// the X-Tenant-Id header on Admin API calls, where the server re-validates
// membership on every request.
export interface InternalBusinessesResponse {
  businesses: InternalBusinessSummary[];
}

// GET /api/v1/internal/me — the authenticated internal user plus the
// authorization summary above. Guarded by InternalAuthGuard only (any
// ACTIVE internal user may read their own summary — no PermissionGuard).
// Since S0F, `user`, `authorization` and its `locations` are all for the
// request's ACTIVE business, named in `business`.
export interface InternalMeResponse {
  business: InternalBusinessSummary;
  user: InternalUserProfile;
  // SC2a — `permissions` / `capabilities` already exclude anything the
  // business's plan does not include.
  authorization: InternalAuthorizationSummary;
  entitlements: InternalEntitlementsSummary;
  // SC4f-3b — the active business's name for its loyalty points ("Points"
  // unless the business chose its own). Presentation only.
  loyaltyPointsLabel: string;
}

// --- CENTERIVO platform operators (SC1a) -------------------------------
// GET /api/v1/platform/me — the authenticated CENTERIVO platform operator.
// Platform-plane: no business, no tenant role, no permission list (SC1a has
// one operator capability: being an ACTIVE operator). Never includes the
// identity provider's subject or any token claim.
export interface PlatformOperatorProfile {
  id: string;
  email: string;
  displayName: string | null;
  status: "ACTIVE";
}

export interface PlatformMeResponse {
  operator: PlatformOperatorProfile;
  // SC3e-2 — the operator's live permissions (what the console offers; the
  // API enforces them on every request).
  permissions: PlatformPermission[];
}

// SC3e-2 (owner decision D1) — platform-operator permissions, least
// privilege: one per kind of billing action (reads need none). Granted and
// revoked only by the provisioning CLI; an operator can never grant itself
// one.
export const PLATFORM_PERMISSIONS = [
  "billing.prices.manage",
  "billing.policy.manage",
  "billing.accounts.manage",
  "billing.reconciliation.run",
  "billing.cases.manage",
  "billing.schedules.release",
  "billing.complimentary.manage",
  // SC3e-3 — refunds and credits (request / approve), and granting
  // permissions in the console.
  "billing.adjustments.request",
  "billing.adjustments.approve",
  "platform.permissions.manage",
  // SC3f — CENTERIVO-wide SaaS revenue reporting (read-only).
  "billing.reports.view",
  // SC4e — owner registration and onboarding oversight: read-only reports,
  // and pausing / resuming new owner registrations.
  "onboarding.view",
  "onboarding.manage",
  // SC4f-3a — assigning approved storefront addresses to a business, and
  // publishing / unpublishing them.
  "storefront.manage",
  // ESP-03 PR 5 — restaurant payment reconciliation cases: read them, and
  // trigger a safe recovery / record internal notes.
  "payments.reconciliation.view",
  "payments.reconciliation.manage",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

// --- SC3e-3: operator permissions in the console (owner decision D7) ------------
// GET /api/v1/platform/operators (platform.permissions.manage): every operator
// and its live permissions (how each was granted).
export interface PlatformOperatorPermissionView {
  permission: PlatformPermission;
  grantedAt: string;
  grantedVia: "CLI" | "CLI_BOOTSTRAP" | "CONSOLE";
  grantedBy: { id: string; email: string } | null;
  reason: string;
}
export interface PlatformOperatorDirectoryEntry {
  id: string;
  email: string;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
  permissions: PlatformOperatorPermissionView[];
}
export interface PlatformOperatorDirectoryResponse {
  operators: PlatformOperatorDirectoryEntry[];
}
// POST /api/v1/platform/operators/:operatorId/permissions — body exactly
// { permission, reason } (platform.permissions.manage, recent sign-in);
// POST .../permissions/revoke — the same body. Never for yourself.
//   409 PLATFORM_PERMISSION_SELF / PLATFORM_OPERATOR_NOT_ACTIVE
export interface PlatformPermissionChangeRequest {
  permission: PlatformPermission;
  reason: string;
}
export const PLATFORM_PERMISSION_SELF = "PLATFORM_PERMISSION_SELF";
export const PLATFORM_OPERATOR_NOT_ACTIVE = "PLATFORM_OPERATOR_NOT_ACTIVE";
// 403 — the operator lacks the permission (or it was revoked).
export const PLATFORM_PERMISSION_REQUIRED = "PLATFORM_PERMISSION_REQUIRED";

// --- CENTERIVO platform-operator sign-in (SC1b) ------------------------
// Server-to-server only: the web tier's server actions call these and keep
// the challenge handle and the session token in HttpOnly cookies. The
// second factor is always required — sign-in never returns a token.

// POST /api/v1/platform/auth/sign-in
export interface PlatformSignInRequest {
  email: string;
  password: string;
}

// An opaque, single-use, short-lived handle to the server-side challenge.
export interface PlatformSignInStepResponse {
  status: "mfa-required" | "mfa-setup-required";
  challenge: string;
}

// POST /api/v1/platform/auth/mfa-setup
export interface PlatformChallengeRequest {
  challenge: string;
}

// The next handle once an authenticator secret has been issued (the secret
// itself stays server-side with the attempt).
export interface PlatformMfaSetupResponse {
  challenge: string;
}

// POST /api/v1/platform/auth/mfa-setup/display — the issued authenticator
// secret, for the setup page to render on the server. Does not advance the
// attempt.
export interface PlatformMfaSetupDisplayResponse {
  secret: string;
  otpauthUri: string;
}

// POST /api/v1/platform/auth/mfa and /mfa-setup/verify
export interface PlatformChallengeCodeRequest {
  challenge: string;
  code: string;
}

export interface PlatformSessionResponse {
  idToken: string;
  expiresInSeconds: number;
}

// --- CENTERIVO platform: tenant registry (SC1c) -------------------------
// Read-only, platform operators only (PlatformAuthGuard). A business's
// registry record and its location summary — never its customers, orders,
// payments, gift cards, loyalty balances or staff.

export type PlatformTenantStatus = "ACTIVE" | "SUSPENDED";
export type PlatformTenantSuspensionReason = "SECURITY" | "BILLING" | "REQUESTED";

export interface PlatformTenantSummary {
  id: string;
  slug: string;
  name: string;
  status: PlatformTenantStatus;
  suspensionReason: PlatformTenantSuspensionReason | null;
  createdAt: string;
  locationCount: number;
}

// GET /api/v1/platform/tenants?q=&status=&page=&pageSize=
// Oldest business first. `q` (1–80 characters: letters, digits, spaces and
// - ' & . ,) matches the name or slug, case-insensitively; `status` is
// ACTIVE or SUSPENDED; page 1–1000; pageSize 1–50 (default 20). Anything
// else is a 400. `total` counts the filtered results; `registry` counts
// every business on the platform, unfiltered.
export interface PlatformTenantListResponse {
  tenants: PlatformTenantSummary[];
  page: number;
  pageSize: number;
  total: number;
  registry: { total: number; active: number; suspended: number };
}

// GET /api/v1/platform/tenants/:tenantId — 404 for an unknown id.
export interface PlatformTenantDetailResponse {
  tenant: Omit<PlatformTenantSummary, "locationCount"> & { updatedAt: string };
  locations: { total: number; active: number; digitalOrderingEnabled: number };
}

export interface PlatformTenantLocation {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
  createdAt: string;
}

// GET /api/v1/platform/tenants/:tenantId/locations?page=&pageSize=
// That business's locations only, by name. Same paging bounds; 404 for an
// unknown business.
export interface PlatformTenantLocationListResponse {
  locations: PlatformTenantLocation[];
  page: number;
  pageSize: number;
  total: number;
}

// --- CENTERIVO platform: business provisioning (SC1d) -------------------
// POST /api/v1/platform/tenants, platform operators only, with an
// `Idempotency-Key` header (a lowercase UUID, one per provisioning attempt).
// Creates, in one transaction: the business (ACTIVE registry status — no
// locations, ordering, payments, storefront or subscription), its built-in
// staff roles, its first owner (an ACTIVE staff member bound to a login on
// first sign-in with that VERIFIED email) and the platform audit event.
//
//   201  created
//   200  replay: the same key and the same request by the same operator —
//        the original result (`replayed: true`); nothing new is created
//   400  invalid request or missing / malformed Idempotency-Key
//   409  code SLUG_TAKEN — another business already uses the slug
//   409  code IDEMPOTENCY_KEY_REUSED — the key was used for a different
//        request (or by another operator)
export const PLATFORM_TENANT_SLUG_TAKEN = "SLUG_TAKEN";
export const PLATFORM_IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED";

export interface PlatformTenantProvisionRequest {
  // 2–120 characters after trimming.
  name: string;
  // 3–50 characters: lowercase letters and digits in hyphen-separated words;
  // a reserved slug (e.g. "admin", "api", "platform") is refused.
  slug: string;
  // Trimmed and lowercased before use.
  ownerEmail: string;
  ownerDisplayName?: string | null;
  // SC2a — the business starts on this PUBLISHED plan version.
  planVersionId: string;
}

export interface PlatformTenantProvisionResponse {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: PlatformTenantStatus;
    createdAt: string;
  };
  owner: {
    // The normalised (lowercase) address the owner must sign in with.
    email: string;
    displayName: string | null;
  };
  replayed: boolean;
}

// --- CENTERIVO platform: business lifecycle (SC1e) ----------------------
// Platform operators only. Every change needs a sign-in (with MFA) within
// the last PLATFORM_LIFECYCLE_RECENT_SIGN_IN_SECONDS; otherwise 401
// REAUTHENTICATION_REQUIRED. A request for the state a business is already
// in changes nothing (`changed: false`) and writes no audit event.

export const PLATFORM_LIFECYCLE_RECENT_SIGN_IN_SECONDS = 15 * 60;
export const PLATFORM_REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED";
// Tenant #1 (Mocha House) cannot be suspended from the platform console.
export const PLATFORM_TENANT_PROTECTED = "TENANT_PROTECTED";
// SC3c-1 — with billing enforcement on, a business suspended for unpaid
// billing is restored only by a confirmed payment (or, later, a time-limited
// grace extension) — never by a plain reactivation.
export const PLATFORM_BILLING_SUSPENSION_ACTIVE = "BILLING_SUSPENSION_ACTIVE";
// SC3c-3 — refusals of a grace extension / billing contact assignment.
//   NOT_EXTENDABLE  — only a PAST_DUE or UNPAID billed subscription.
//   EXTENSION_LIMIT — more than 14 days, or more than 60 in the episode.
//   NOT_RECOVERABLE — the provider's subscription has ended (or is not
//                     ours / not readable as recoverable).
//   CONTACT_NOT_ELIGIBLE — not an ACTIVE staff member of THIS business
//                          holding billing.manage business-wide.
export const PLATFORM_BILLING_NOT_EXTENDABLE = "BILLING_NOT_EXTENDABLE";
export const PLATFORM_BILLING_EXTENSION_LIMIT = "BILLING_EXTENSION_LIMIT";
export const PLATFORM_BILLING_NOT_RECOVERABLE = "BILLING_NOT_RECOVERABLE";
export const PLATFORM_BILLING_CONTACT_NOT_ELIGIBLE = "BILLING_CONTACT_NOT_ELIGIBLE";
export const PLATFORM_OWNER_ALREADY_SIGNED_IN = "OWNER_ALREADY_SIGNED_IN";
export const PLATFORM_OWNER_EMAIL_IN_USE = "OWNER_EMAIL_IN_USE";

export interface PlatformTenantOwner {
  id: string;
  email: string;
  displayName: string | null;
  // Whether the owner has ever signed in (a login is bound to the record).
  signedIn: boolean;
}

// GET /api/v1/platform/tenants/:tenantId/lifecycle
export interface PlatformTenantLifecycleResponse {
  tenantId: string;
  status: PlatformTenantStatus;
  suspensionReason: PlatformTenantSuspensionReason | null;
  // true for Tenant #1: never suspended from the console.
  protected: boolean;
  // The business's first owner: the earliest staff member holding the
  // built-in administrator role at corporate scope (null if none).
  owner: PlatformTenantOwner | null;
  // Counts only (no customer data): what a suspension holds.
  impact: { openOrders: number; pendingNotifications: number };
}

// POST /api/v1/platform/tenants/:tenantId/suspend
//   409 TENANT_PROTECTED for Tenant #1.
export interface PlatformTenantSuspendRequest {
  reason: PlatformTenantSuspensionReason;
}

// POST /api/v1/platform/tenants/:tenantId/reactivate  (no body)
export interface PlatformTenantStatusChangeResponse {
  status: PlatformTenantStatus;
  suspensionReason: PlatformTenantSuspensionReason | null;
  changed: boolean;
}

// POST /api/v1/platform/tenants/:tenantId/owner-email
// Corrects the first owner's email while they have never signed in.
//   404 unknown business or not its first owner
//   409 OWNER_ALREADY_SIGNED_IN — a login is bound; nothing changes
//   409 OWNER_EMAIL_IN_USE — another staff member of this business already
//       uses that address (in any letter case)
export interface PlatformTenantOwnerEmailRequest {
  ownerId: string;
  // Trimmed and lowercased before use.
  email: string;
}

export interface PlatformTenantOwnerEmailResponse {
  owner: PlatformTenantOwner;
  changed: boolean;
}

// --- CENTERIVO platform: plans and subscriptions (SC2a) -----------------
// Platform operators only. Changes need a recent sign-in (as SC1e) and are
// audited. SaaS plans are separate from a business's customer payments.
// SC3a adds list prices (versioned independently of features) and the
// billing policy; nothing charges anyone yet.

export type PlatformPlanVersionStatus = "DRAFT" | "PUBLISHED" | "RETIRED";

export const PLATFORM_PLAN_KEY_TAKEN = "PLAN_KEY_TAKEN";
export const PLATFORM_PLAN_DRAFT_EXISTS = "PLAN_DRAFT_EXISTS";
export const PLATFORM_PLAN_VERSION_NOT_DRAFT = "PLAN_VERSION_NOT_DRAFT";
export const PLATFORM_PLAN_VERSION_NOT_PUBLISHED = "PLAN_VERSION_NOT_PUBLISHED";
export const PLATFORM_NO_SUBSCRIPTION = "NO_SUBSCRIPTION";
export const PLATFORM_ADDON_IN_PLAN = "ADDON_IN_PLAN";
// SC3a — a BILLED subscription changes plan or add-ons only through billing
// (the paid modules follow confirmed payment; SC3d), never directly.
export const PLATFORM_SUBSCRIPTION_BILLED = "SUBSCRIPTION_BILLED";

export interface PlatformPlanVersion {
  id: string;
  version: number;
  status: PlatformPlanVersionStatus;
  moduleKeys: OptionalModuleKey[];
  publishedAt: string | null;
  retiredAt: string | null;
  // Businesses currently subscribed to this version.
  subscriberCount: number;
}

// SC3a — a plan's list price for one interval. A new price is a new row and
// the previous ACTIVE one is ARCHIVED; businesses keep the price they agreed
// to. USD only for now. Amounts are integer minor units (cents).
export type PlatformBillingInterval = "MONTH" | "YEAR";
export type PlatformPlanPriceStatus = "ACTIVE" | "ARCHIVED";

export interface PlatformPlanPrice {
  id: string;
  interval: PlatformBillingInterval;
  currency: string;
  amountMinorUnits: number;
  status: PlatformPlanPriceStatus;
  createdAt: string;
  archivedAt: string | null;
  // Businesses whose agreed price this is.
  subscriberCount: number;
}

export interface PlatformPlan {
  id: string;
  key: string;
  name: string;
  description: string | null;
  // SC4b — offered to business owners creating a business themselves.
  selfServiceAvailable: boolean;
  versions: PlatformPlanVersion[];
  // SC3a — newest first, ACTIVE and ARCHIVED.
  prices: PlatformPlanPrice[];
}

// SC4b — PUT /api/v1/platform/plans/:planId/self-service: offer (or stop
// offering) a plan to owners creating a business themselves. 409
// PLAN_NOT_SELF_SERVICE for the Founding plan.
export interface PlatformPlanSelfServiceRequest {
  available: boolean;
}
export const PLATFORM_PLAN_NOT_SELF_SERVICE = "PLAN_NOT_SELF_SERVICE";

export const PLATFORM_PRICE_NOT_ACTIVE = "PRICE_NOT_ACTIVE";
export const PLATFORM_NO_MONTHLY_PRICE = "NO_MONTHLY_PRICE";

// POST /api/v1/platform/plans/:planId/prices — a new ACTIVE list price for
// one interval (the previous ACTIVE price for that interval is archived in
// the same change). Give EITHER `amountMinorUnits`, OR — for YEAR only —
// `annualDiscountBasisPoints` (1–9999: e.g. 1500 = 15% off twelve times the
// plan's ACTIVE monthly price; 409 NO_MONTHLY_PRICE without one). The
// discount is never hard-coded: the stored price is the resulting amount.
export interface PlatformPlanPriceCreateRequest {
  interval: PlatformBillingInterval;
  // "USD" only for now (optional).
  currency?: string;
  amountMinorUnits?: number;
  annualDiscountBasisPoints?: number;
}

// POST /api/v1/platform/plans/:planId/prices/:priceId/archive — stop
// offering a price; 409 PRICE_NOT_ACTIVE if already archived. Businesses on
// it keep it.

// SC3a — the platform billing policy (one, platform-wide). Changes apply to
// trials and grace periods that START afterwards.
// GET /api/v1/platform/billing/policy
// PUT /api/v1/platform/billing/policy
export interface PlatformBillingPolicy {
  // 0–90 (0 = no trial).
  trialDays: number;
  trialRequiresPaymentMethod: boolean;
  // 1–60: full access after a failed payment before billing suspension.
  gracePeriodDays: number;
  updatedAt: string;
}

export interface PlatformBillingPolicyUpdateRequest {
  trialDays: number;
  trialRequiresPaymentMethod: boolean;
  gracePeriodDays: number;
}

// --- SC3b — Stripe Billing (test mode) ----------------------------------
// A business's billing as the platform and the business itself see it.
// AWAITING_SETUP: billing was started by an operator; the owner has not yet
// completed payment setup (hosted Checkout).
export type BusinessBillingState =
  | "COMPLIMENTARY"
  | "AWAITING_SETUP"
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "UNPAID"
  | "TRIAL_EXPIRED"
  | "CANCELED";

export interface BusinessBillingSummary {
  state: BusinessBillingState;
  planName: string;
  // The agreed price (null while COMPLIMENTARY).
  price: {
    amountMinorUnits: number;
    currency: string;
    interval: PlatformBillingInterval;
  } | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  // SC3c-1 — an expired trial: when its restricted recovery window ends
  // (the business is then suspended for billing). Null otherwise.
  recoveryEndsAt: string | null;
  // SC3c-3 — UNPAID only: an operator's temporary grace exception, until.
  graceExceptionEndsAt: string | null;
  // SC3c-1 — what billing enforcement actually does to the business NOW
  // (server-derived; never inferred by the client). All false while
  // enforcement is off.
  //   enforced            — billing enforcement is on in this environment.
  //   premiumPaused       — the plan's premium modules are off (core stays).
  //   suspendedForBilling — the business is suspended for billing.
  enforced: boolean;
  premiumPaused: boolean;
  suspendedForBilling: boolean;
  cancelAtPeriodEnd: boolean;
  paymentMethodOnFile: boolean;
  // SC4b/SC4c — a business its owner created that has not completed its
  // first payment setup (no verified payment or trial yet): core only, no
  // customer sales; the plan can still be changed (SC4c).
  initialSetupPending: boolean;
  // SC3e-4 — payment setup (a billed business without a verified, paid
  // provider subscription):
  //   required — payment setup is needed now;
  //   since    — since when (informational, also while enforcement is off);
  //   deadline — the setup window's deadline: ONLY while billing
  //              enforcement is on (never a deadline that wouldn't apply);
  //   expired  — the deadline passed (access is limited to billing).
  paymentSetup: {
    required: boolean;
    since: string | null;
    deadline: string | null;
    expired: boolean;
  };
}

export const BILLING_UNAVAILABLE = "BILLING_UNAVAILABLE";
export const BILLING_NOT_BILLED = "BILLING_NOT_BILLED";
export const BILLING_ALREADY_SET_UP = "BILLING_ALREADY_SET_UP";
export const BILLING_CHECKOUT_IN_PROGRESS = "BILLING_CHECKOUT_IN_PROGRESS";
export const BILLING_CHECKOUT_PROCESSING = "BILLING_CHECKOUT_PROCESSING";
// Another business of the same owner holds the one-time trial in an open
// Checkout: finish or leave that one first.
export const BILLING_TRIAL_PENDING_ELSEWHERE = "BILLING_TRIAL_PENDING_ELSEWHERE";
// SC3c-2 — billing recovery refusals.
//   BILLING_NOTHING_TO_PAY      — no open invoice of this subscription to pay.
//   BILLING_SUBSCRIPTION_NOT_ENDED — a restart needs the old subscription
//                                  to have ENDED at the provider.
export const BILLING_NOTHING_TO_PAY = "BILLING_NOTHING_TO_PAY";
export const BILLING_SUBSCRIPTION_NOT_ENDED = "BILLING_SUBSCRIPTION_NOT_ENDED";
//   BILLING_RECOVERY_UNDER_REVIEW  — a restart payment could not be linked
//                                  and is being reviewed: no new attempt
//                                  (no second charge) until it is resolved.
export const BILLING_RECOVERY_UNDER_REVIEW = "BILLING_RECOVERY_UNDER_REVIEW";

// GET /api/v1/admin/billing (billing.view) — the signed-in business's own.
export interface AdminBillingResponse {
  billing: BusinessBillingSummary;
  // Payment setup can be started now (billing.manage holders only).
  canSetUpPayment: boolean;
  // SC3c-2 — recovery actions available now (billing.manage holders only):
  //   canRestartSubscription — an ended subscription (expired trial or
  //     canceled): a new, paid subscription through Checkout (no trial).
  //   canPayInvoice — an outstanding invoice can be paid on the provider's
  //     hosted page.
  //   canManagePaymentMethod — the provider's Customer Portal (payment
  //     methods and invoices only) is configured and available.
  canRestartSubscription: boolean;
  canPayInvoice: boolean;
  canManagePaymentMethod: boolean;
  // SC3d-2 — plans can be changed now (billing.manage holders only; ACTIVE
  // billed subscriptions, no change in progress), and the business's latest
  // plan change (null: none worth showing).
  canChangePlan: boolean;
  planChange: AdminPlanChangeView | null;
  // SC4c — only while a self-service business has not completed its first
  // payment setup (null otherwise).
  initialSetup: AdminInitialSetupView | null;
}

// SC4c — a self-service business's first payment setup.
//   selectionAvailable — the chosen plan and price are still offered; when
//     false (a retired price, a withdrawn plan), the owner must choose again
//     before payment setup (never substituted).
//   trial — the free trial payment setup would start (null: none), decided
//     by the existing trial rules; it starts only when the provider confirms.
//   canChangeSelection — billing.manage holders, before payment setup is done.
export interface AdminInitialSetupView {
  selectionAvailable: boolean;
  trial: { days: number; requiresPaymentMethod: boolean } | null;
  canChangeSelection: boolean;
}

// GET /api/v1/admin/billing/initial-plan-options (billing.view) — the plans
// the owner may choose (the self-service offer) and the current choice.
export interface AdminInitialPlanOptionsResponse {
  plans: OwnerOnboardingPlanOption[];
  current: { planVersionId: string; planPriceId: string };
}

// POST /api/v1/admin/billing/initial-plan (billing.manage) — change the
// plan and price before the first payment setup, with the price as shown.
// An open Checkout is ended first; one that already completed refuses.
export interface AdminInitialPlanChangeRequest {
  planVersionId: string;
  planPriceId: string;
  expectedPrice: {
    interval: PlatformBillingInterval;
    currency: string;
    amountMinorUnits: number;
  };
}

// 409 — the chosen plan or price is no longer offered: choose again.
export const BILLING_SELECTION_UNAVAILABLE = "BILLING_SELECTION_UNAVAILABLE";
// 409 — the plan can be changed here only before the first payment setup.
export const BILLING_SELECTION_LOCKED = "BILLING_SELECTION_LOCKED";

// POST /api/v1/admin/billing/checkout (billing.manage) — no body: the
// business, price and trial come ONLY from the server's records. Returns
// the provider's hosted Checkout page for this business (an open one is
// reused; at most one at a time).
//   409 BILLING_NOT_BILLED / BILLING_ALREADY_SET_UP /
//       BILLING_CHECKOUT_IN_PROGRESS / BILLING_CHECKOUT_PROCESSING /
//       BILLING_TRIAL_PENDING_ELSEWHERE / BILLING_SUBSCRIPTION_NOT_ENDED
//   503 BILLING_UNAVAILABLE
// SC3c-2 — also restarts an ENDED subscription (no trial).
export interface AdminBillingCheckoutResponse {
  url: string;
}

// SC3c-2 — POST /api/v1/admin/billing/recovery/invoice and
// POST /api/v1/admin/billing/recovery/portal (billing.manage; no body). The
// provider's hosted page for the business's outstanding invoice (found and
// verified from OUR records — never a client value), or its Customer Portal
// session (payment methods and invoices only).
//   409 BILLING_NOT_BILLED / BILLING_NOTHING_TO_PAY
//   503 BILLING_UNAVAILABLE
export interface AdminBillingRecoveryResponse {
  url: string;
}

// --- SC3e-1: billing history ------------------------------------------------------
// The business's CENTERIVO subscription invoices, as the billing provider
// last reported them (the provider stays authoritative for money). Never a
// restaurant order, payment or refund.

export type BillingInvoiceStatus = "open" | "paid" | "void" | "uncollectible";
// Why the invoice was issued (the provider's reason, simplified).
export type BillingInvoiceReason =
  | "SUBSCRIPTION_START"
  | "RENEWAL"
  | "PLAN_CHANGE"
  | "OTHER";

export interface BillingInvoiceView {
  // Our id (the only one a client ever sends back).
  id: string;
  number: string | null;
  status: BillingInvoiceStatus;
  reason: BillingInvoiceReason;
  // Upper-case ISO currency.
  currency: string;
  totalMinorUnits: number;
  amountPaidMinorUnits: number;
  amountRemainingMinorUnits: number;
  // Credit notes issued after payment (refunds or account credits).
  refundedOrCreditedMinorUnits: number;
  // Credit notes before payment and account credit balance used.
  creditAppliedMinorUnits: number;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  paidAt: string | null;
  // SC3e-3 — refunds and credits on it (pending or completed).
  adjustments: BillingInvoiceAdjustmentView[];
}

// GET /api/v1/admin/billing/invoices?cursor= (billing.view) and
// GET /api/v1/platform/tenants/:tenantId/billing/invoices?cursor=
// (operators): newest first, 20 a page; nextCursor null on the last page.
//   400 an unreadable cursor
export interface BillingInvoiceListResponse {
  invoices: BillingInvoiceView[];
  nextCursor: string | null;
}

// POST /api/v1/admin/billing/invoices/:invoiceId/document — body exactly
// { kind } (billing.view): the billing provider's own page or PDF for that
// invoice of THIS business, resolved for this request only (never stored).
//   404 not this business's invoice
//   409 BILLING_DOCUMENT_UNAVAILABLE — the provider offers no document
//   503 BILLING_UNAVAILABLE
export type BillingInvoiceDocumentKind = "invoice" | "pdf";
export interface BillingInvoiceDocumentRequest {
  kind: BillingInvoiceDocumentKind;
}
export const BILLING_DOCUMENT_UNAVAILABLE = "BILLING_DOCUMENT_UNAVAILABLE";

// GET /api/v1/admin/billing/payment-method (billing.view): what may be shown
// of the payment method the provider charges — never a card number,
// fingerprint, billing address or provider id. Changing it is the provider's
// Customer Portal (billing.manage).
//   503 BILLING_UNAVAILABLE
export interface BillingPaymentMethodView {
  // NONE: nothing to charge; CARD: a card (shown); OTHER: another method or
  // one that cannot be shown.
  kind: "NONE" | "CARD" | "OTHER";
  card: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    expired: boolean;
  } | null;
}
export interface AdminBillingPaymentMethodResponse {
  // null: this business is not billed by a provider.
  paymentMethod: BillingPaymentMethodView | null;
}

// --- SC3d: plan changes ---------------------------------------------------------
// SC3d-1 — a PREVIEW of changing the business's plan or price, with the
// billing provider's own calculation. Nothing is charged or changed; the
// preview is recorded (valid 10 minutes) so a later confirmation can only
// ever be for exactly what was shown.
//
// POST /api/v1/admin/billing/plan-change/preview — body exactly
// { planPriceId } (billing.manage, business-wide; FULL access only).
// POST /api/v1/platform/tenants/:tenantId/billing/plan-change/preview — the
// same, by a platform operator.
//   409 BILLING_PLAN_CHANGE_UNAVAILABLE — not billed, not active or trialing
//       (past due, unpaid, ended: recover billing first), cancellation
//       scheduled, the business suspended, or the plan not offered;
//   409 BILLING_PLAN_CHANGE_SAME_PRICE / BILLING_PLAN_CHANGE_CURRENCY;
//   409 BILLING_PLAN_CHANGE_IN_PROGRESS — another change is open;
//   409 BILLING_PLAN_CHANGE_UNVERIFIED — the provider bills something other
//       than our records say (a review case is opened);
//   503 BILLING_UNAVAILABLE
export const BILLING_PLAN_CHANGE_UNAVAILABLE = "BILLING_PLAN_CHANGE_UNAVAILABLE";
export const BILLING_PLAN_CHANGE_SAME_PRICE = "BILLING_PLAN_CHANGE_SAME_PRICE";
export const BILLING_PLAN_CHANGE_CURRENCY = "BILLING_PLAN_CHANGE_CURRENCY";
export const BILLING_PLAN_CHANGE_IN_PROGRESS = "BILLING_PLAN_CHANGE_IN_PROGRESS";
export const BILLING_PLAN_CHANGE_UNVERIFIED = "BILLING_PLAN_CHANGE_UNVERIFIED";
// SC3d-2 — confirming a preview:
//   BILLING_PLAN_CHANGE_PREVIEW_EXPIRED — older than 10 minutes, already used,
//       or no longer for this business's current plan: preview again;
//   BILLING_PLAN_CHANGE_PREVIEW_CHANGED — the provider would now charge a
//       different amount (or the plan / price changed): preview again and
//       confirm the new charge;
//   BILLING_PLAN_CHANGE_NOT_PAYABLE — no plan change payment is waiting.
export const BILLING_PLAN_CHANGE_PREVIEW_EXPIRED = "BILLING_PLAN_CHANGE_PREVIEW_EXPIRED";
export const BILLING_PLAN_CHANGE_PREVIEW_CHANGED = "BILLING_PLAN_CHANGE_PREVIEW_CHANGED";
export const BILLING_PLAN_CHANGE_NOT_PAYABLE = "BILLING_PLAN_CHANGE_NOT_PAYABLE";
// SC3d-3 — scheduled changes:
//   BILLING_PLAN_CHANGE_TOO_LATE — within an hour of the period (or trial)
//       end: try again after the renewal;
//   BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED — choosing the plan after a
//       trial needs a payment method on file (a cardless trial keeps its
//       expiry and recovery);
//   BILLING_PLAN_CHANGE_NOT_CANCELABLE — no scheduled change to cancel.
export const BILLING_PLAN_CHANGE_TOO_LATE = "BILLING_PLAN_CHANGE_TOO_LATE";
export const BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED =
  "BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED";
export const BILLING_PLAN_CHANGE_NOT_CANCELABLE = "BILLING_PLAN_CHANGE_NOT_CANCELABLE";

// IMMEDIATE: an upgrade (or monthly -> annual), charged now with proration;
// PERIOD_END: a downgrade (or annual -> monthly), at the end of the period;
// TRIAL_END: the plan the trial becomes (nothing charged now).
export type BillingPlanChangeTiming = "IMMEDIATE" | "PERIOD_END" | "TRIAL_END";

export interface BillingPlanChangePreviewRequest {
  planPriceId: string;
}

export interface BillingPlanChangeSide {
  planName: string;
  price: {
    amountMinorUnits: number;
    currency: string;
    interval: PlatformBillingInterval;
  };
}

export interface BillingPlanChangePreview {
  previewId: string;
  timing: BillingPlanChangeTiming;
  current: BillingPlanChangeSide;
  target: BillingPlanChangeSide;
  // IMMEDIATE only: what would be charged now (minor units), after credits
  // for unused time, discounts and tax, as the provider calculated it.
  chargeNow: {
    amountDueMinorUnits: number;
    totalMinorUnits: number;
    taxMinorUnits: number;
    discountMinorUnits: number;
    prorationMinorUnits: number;
    currency: string;
  } | null;
  // SC3d-3 — the features the change removes / adds (at the switch for a
  // scheduled change). Nothing is ever deleted.
  modules: {
    lost: { key: string; label: string }[];
    gained: { key: string; label: string }[];
  };
  // The recurring bill after the change, and from when (null: now).
  nextRecurring: {
    amountMinorUnits: number;
    currency: string;
    interval: PlatformBillingInterval;
    startsAt: string | null;
  };
  expiresAt: string;
}

// SC3d-2 — what the business sees about its plan change.
//   PROCESSING      confirmed; the payment provider is being asked;
//   PAYMENT_NEEDED  the charge did not go through yet (e.g. a declined card
//                   or a 3-D Secure step): pay on the provider's page; the
//                   current plan stays until then;
//   APPLIED         paid and verified: the new plan is active;
//   REVIEW          our team is checking it (nothing more to do);
//   EXPIRED         the payment was not completed in time: nothing changed;
//   FAILED          it could not be submitted: nothing changed.
export type AdminPlanChangeStatus =
  // SC3d-3 — scheduled for its date (cancellable until an hour before), or
  // cancelled by the business.
  | "SCHEDULED"
  | "CANCELED"
  | "PROCESSING"
  | "PAYMENT_NEEDED"
  | "APPLIED"
  | "REVIEW"
  | "EXPIRED"
  | "FAILED";

export interface AdminPlanChangeView {
  id: string;
  status: AdminPlanChangeStatus;
  timing: BillingPlanChangeTiming;
  // SC3e-1 — the features the change removes (when it takes effect).
  modulesLost: { key: string; label: string }[];
  // When a scheduled change takes effect (null: immediate).
  effectiveAt: string | null;
  target: BillingPlanChangeSide;
  // The charge the business confirmed (minor units).
  amountDueMinorUnits: number | null;
  currency: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

// POST /api/v1/admin/billing/plan-change/confirm — body exactly
// { previewId } (billing.manage, business-wide; FULL access only). The ONLY
// way a plan change is charged: the business's own confirmation of the
// preview it was shown (operators preview, never confirm).
//   409 BILLING_PLAN_CHANGE_PREVIEW_EXPIRED / _PREVIEW_CHANGED / _IN_PROGRESS /
//       _UNAVAILABLE / _UNVERIFIED
//   503 BILLING_UNAVAILABLE
export interface BillingPlanChangeConfirmRequest {
  previewId: string;
}

export interface BillingPlanChangeConfirmResponse {
  planChange: AdminPlanChangeView;
}

// POST /api/v1/admin/billing/plan-change/pay (billing.manage; no body): the
// provider's hosted page for the WAITING plan change's own invoice (verified
// from our records — never a client value).
//   409 BILLING_PLAN_CHANGE_NOT_PAYABLE

// GET /api/v1/admin/billing/plan-options (billing.view): the prices the
// business may move to (offered plans, same currency).
// POST /api/v1/admin/billing/plan-change/cancel — body exactly
// { planChangeId } (billing.manage): withdraws a SCHEDULED change (its
// provider schedule is RELEASED; the subscription is untouched).
//   409 BILLING_PLAN_CHANGE_NOT_CANCELABLE / BILLING_PLAN_CHANGE_TOO_LATE
export interface BillingPlanChangeCancelRequest {
  planChangeId: string;
}

export interface AdminPlanOption {
  planPriceId: string;
  planName: string;
  amountMinorUnits: number;
  currency: string;
  interval: PlatformBillingInterval;
  current: boolean;
}

export interface AdminPlanOptionsResponse {
  options: AdminPlanOption[];
}

// POST /api/v1/platform/tenants/:tenantId/billing/plan-change/preview —
// SC3d-2: an operator's preview needs a recent sign-in and a written reason
// (10–500 characters); body exactly { planPriceId, reason }.
export interface PlatformPlanChangePreviewRequest {
  planPriceId: string;
  reason: string;
}

export const PLATFORM_ALREADY_BILLED = "ALREADY_BILLED";
export const PLATFORM_FOUNDING_COMPLIMENTARY = "FOUNDING_COMPLIMENTARY";
export const PLATFORM_PRICE_NOT_FOR_PLAN = "PRICE_NOT_FOR_PLAN";
export const PLATFORM_NO_OWNER = "NO_OWNER";

// POST /api/v1/platform/tenants/:tenantId/billing/start — an operator starts
// billing a COMPLIMENTARY (non-Founding) business at one ACTIVE price of its
// current plan; the owner then sets up payment. 409 ALREADY_BILLED /
// FOUNDING_COMPLIMENTARY / PRICE_NOT_FOR_PLAN / PRICE_NOT_ACTIVE / NO_OWNER;
// 503 BILLING_UNAVAILABLE.
export interface PlatformStartBillingRequest {
  planPriceId: string;
}

// GET /api/v1/platform/tenants/:tenantId/billing
export interface PlatformTenantBillingResponse {
  tenantId: string;
  billing: BusinessBillingSummary | null;
  // SC3c-3 — who billing email goes to, and the grace extensions so far.
  contact: PlatformBillingContactView;
  extensions: PlatformGraceExtension[];
  // Days still available in the current unpaid episode (null: none open).
  extensionDaysRemaining: number | null;
  // SC3e-4 — the payment setup window (null: payment setup isn't needed).
  paymentSetup: PlatformPaymentSetupView | null;
}

// SC3e-4 — a billed business that still needs payment setup.
//   windowStartedAt / deadline — only while billing enforcement is on;
//   latestDeadline — the furthest an operator may extend it (30 days from
//                    the window's start);
//   extensions — this window's extensions (reason, operator).
export interface PlatformPaymentSetupView {
  enforced: boolean;
  since: string;
  windowStartedAt: string | null;
  deadline: string | null;
  latestDeadline: string | null;
  expired: boolean;
  extensions: (PlatformGraceExtension & { operatorEmail: string })[];
}

// GET /api/v1/platform/billing/payment-setup — every billed business that
// still needs payment setup, soonest deadline first (any operator).
export interface PlatformPaymentSetupListResponse {
  enforced: boolean;
  items: (PlatformPaymentSetupView & {
    tenantId: string;
    businessName: string;
    planName: string;
  })[];
}

// POST /api/v1/platform/tenants/:tenantId/billing/payment-setup/extension —
// body exactly { days, reason } (billing.accounts.manage, recent sign-in;
// audited). Extends the setup deadline by 1–14 days, never past 30 days
// from the window's start. Returns PlatformTenantBillingResponse.
//   409 BILLING_NOT_EXTENDABLE (no setup window: enforcement off, or setup
//       not needed) / BILLING_EXTENSION_LIMIT (past 30 days)

// SC3c-3 — the designated billing contact and the recipient billing email
// would go to right now (re-checked again at delivery time).
export type BillingRecipientSource = "CONTACT" | "FALLBACK_ADMINISTRATOR";
export type BillingRecipientIneligibility =
  | "NOT_ACTIVE"
  | "NO_BILLING_MANAGE"
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_VERIFICATION_STALE";

export interface PlatformBillingStaffMember {
  internalUserId: string;
  email: string;
  displayName: string | null;
  // null when eligible to receive billing email now.
  ineligibleReason: BillingRecipientIneligibility | null;
}

export interface PlatformBillingContactView {
  designated: PlatformBillingStaffMember | null;
  // Where billing email would go now (null: nobody eligible — nothing is
  // sent and a BILLING_CONTACT_MISSING case is opened).
  recipient: (PlatformBillingStaffMember & { source: BillingRecipientSource }) | null;
  // Staff of THIS business who may be designated (ACTIVE, billing.manage
  // business-wide).
  candidates: PlatformBillingStaffMember[];
}

// PUT /api/v1/platform/tenants/:tenantId/billing/contact — body exactly
// { internalUserId } (recent sign-in; audited).
//   409 BILLING_CONTACT_NOT_ELIGIBLE
export interface PlatformAssignBillingContactRequest {
  internalUserId: string;
}

// SC3e-4 — PAYMENT_SETUP: an operator extended a payment setup deadline.
export type PlatformGraceExtensionKind = "GRACE_EXTENDED" | "GRACE_EXCEPTION" | "PAYMENT_SETUP";

export interface PlatformGraceExtension {
  id: string;
  kind: PlatformGraceExtensionKind;
  days: number;
  previousEndsAt: string;
  newEndsAt: string;
  reason: string;
  createdAt: string;
}

// POST /api/v1/platform/tenants/:tenantId/billing/grace-extension — body
// exactly { days, reason } (recent sign-in; audited). PAST_DUE: the grace
// period is extended. UNPAID: an explicit, time-limited grace EXCEPTION
// (temporary access; the subscription stays UNPAID). At most 14 days each,
// 60 per unpaid episode; the debt is never touched.
//   409 BILLING_NOT_EXTENDABLE / BILLING_EXTENSION_LIMIT /
//       BILLING_NOT_RECOVERABLE
export interface PlatformGraceExtensionRequest {
  days: number;
  reason: string;
}

// GET /api/v1/platform/billing/overview — counts for the operator console
// (no external paging).
export interface PlatformBillingOverview {
  // SC3e-2 — complimentary arrangements (active, waiting for the paid period
  // to end, ending within 14 days, needing attention).
  complimentary: {
    active: number;
    scheduled: number;
    endingSoon: number;
    attention: number;
  };
  inGrace: number;
  unpaid: number;
  billingSuspended: number;
  graceExceptions: number;
  trialRecoveryWindows: number;
  missingContacts: number;
  failedNotifications: number;
  openCases: { kind: string; count: number }[];
}

// Review-only billing reconciliation (operators). Running it or resolving a
// case never moves money or changes a subscription.
export type PlatformReconciliationCaseStatus = "OPEN" | "RESOLVED";

export interface PlatformReconciliationCase {
  id: string;
  kind: string;
  tenantId: string | null;
  businessName: string | null;
  detail: string | null;
  status: PlatformReconciliationCaseStatus;
  createdAt: string;
  resolvedAt: string | null;
  // SC3e-2 — how it was closed, and the note.
  resolutionOutcome: PlatformCaseOutcome | null;
  resolutionNote: string | null;
}

// --- SC3e-2: review-case actions (owner decision D5) ------------------------------
// Closing outcomes. Nothing here moves money or adopts a provider price.
export const PLATFORM_CASE_OUTCOMES = [
  "FIXED_AT_PROVIDER",
  "SCHEDULE_RELEASED",
  "CONSISTENT_ON_RECHECK",
  "NO_ACTION_NEEDED",
  "DUPLICATE",
  "NEEDS_FINANCIAL_ADJUSTMENT",
] as const;
export type PlatformCaseOutcome = (typeof PLATFORM_CASE_OUTCOMES)[number];

export interface PlatformCaseActionView {
  action: "RECHECKED" | "SCHEDULE_RELEASED" | "CLOSED";
  result: string;
  note: string | null;
  externalScheduleId: string | null;
  actor: { id: string; email: string };
  at: string;
}

// GET /api/v1/platform/billing/reconciliation-cases/:caseId — the case, its
// action history and, when it concerns a subscription, what the provider
// holds now (read-only).
export interface PlatformCaseDetailResponse {
  case: PlatformReconciliationCase;
  actions: PlatformCaseActionView[];
  provider: {
    // A schedule attached to the subscription right now (null: none).
    schedule: { externalScheduleId: string; status: string } | null;
    // Our records hold an open scheduled plan change on it (not releasable
    // here: the business cancels that one).
    scheduleIsOpenPlanChange: boolean;
  } | null;
  // Why the provider could not be read (null: read, or not applicable).
  providerUnavailable: boolean;
}

// POST .../reconciliation-cases/:caseId/recheck (billing.cases.manage) — the
// provider is read again and our settlement re-run for that subscription
// (no provider write). Body: none.
export interface PlatformCaseRecheckResponse {
  result: "CONSISTENT" | "MISMATCH_FOUND" | "PROVIDER_UNAVAILABLE";
  openCases: string[];
}

// POST .../reconciliation-cases/:caseId/release-schedule — body exactly
// { externalScheduleId, reason } (billing.schedules.release, recent
// sign-in): releases THE schedule attached to the case's subscription (it
// must match what the provider holds now; never cancelled).
//   409 BILLING_CASE_SCHEDULE_MISMATCH / BILLING_CASE_NOT_RELEASABLE
export interface PlatformCaseReleaseRequest {
  externalScheduleId: string;
  reason: string;
}

// POST .../reconciliation-cases/:caseId/resolve — body exactly
// { outcome, note } (billing.cases.manage).
export interface PlatformCaseCloseRequest {
  outcome: PlatformCaseOutcome;
  note: string;
}
export const BILLING_CASE_SCHEDULE_MISMATCH = "BILLING_CASE_SCHEDULE_MISMATCH";
export const BILLING_CASE_NOT_RELEASABLE = "BILLING_CASE_NOT_RELEASABLE";

// --- SC3e-2: complimentary arrangements (owner decisions D2–D4) --------------------
export type PlatformComplimentaryStatus =
  | "SCHEDULED"
  | "ACTIVE"
  | "WITHDRAWN"
  | "ENDED";

export interface PlatformComplimentaryGrantView {
  id: string;
  status: PlatformComplimentaryStatus;
  plan: { planName: string; versionId: string; version: number; moduleKeys: string[] };
  // null: indefinite.
  endsAt: string | null;
  reason: string;
  grantedBy: { id: string; email: string };
  createdAt: string;
  previousStatus: string;
  previousPlanName: string;
  previousPrice: { amountMinorUnits: number; currency: string; interval: "MONTH" | "YEAR" };
  // SCHEDULED: when the paid period ends (the provider ends the subscription).
  effectiveAt: string | null;
  cancellationVerified: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  // EXPIRED | REVOKED | WITHDRAWN | PROVIDER_UNDONE | NOT_SUBMITTED
  finishCode: string | null;
  finishReason: string | null;
  finishedBy: { id: string; email: string } | null;
  // What needs an operator (null: nothing).
  attention: "CANCELLATION_UNVERIFIED" | "ENDS_SOON" | null;
}

// GET /api/v1/platform/tenants/:tenantId/billing/complimentary
export interface PlatformComplimentaryView {
  billingMode: "BILLED" | "COMPLIMENTARY";
  // COMPLIMENTARY with no grant on record (Founding, or never billed).
  legacyComplimentary: boolean;
  current: PlatformComplimentaryGrantView | null;
  history: PlatformComplimentaryGrantView[];
  // From our records only (the provider is checked when granting).
  eligibility: { eligible: boolean; reason: string | null };
}

// POST /api/v1/platform/tenants/:tenantId/billing/complimentary — body
// exactly { planVersionId, endsAt, reason } (billing.complimentary.manage,
// recent sign-in). endsAt: an ISO time (time-limited) or null (indefinite).
//   409 BILLING_COMPLIMENTARY_NOT_ELIGIBLE / _UNPAID_INVOICES / _IN_PROGRESS
export interface PlatformComplimentaryGrantRequest {
  planVersionId: string;
  endsAt: string | null;
  reason: string;
}
// POST .../complimentary/:grantId/withdraw | /revoke — body exactly { reason }.
//   409 BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE / _NOT_REVOCABLE
export interface PlatformComplimentaryReasonRequest {
  reason: string;
}
export const BILLING_COMPLIMENTARY_NOT_ELIGIBLE = "BILLING_COMPLIMENTARY_NOT_ELIGIBLE";
export const BILLING_COMPLIMENTARY_UNPAID_INVOICES = "BILLING_COMPLIMENTARY_UNPAID_INVOICES";
export const BILLING_COMPLIMENTARY_IN_PROGRESS = "BILLING_COMPLIMENTARY_IN_PROGRESS";
export const BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE = "BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE";
export const BILLING_COMPLIMENTARY_NOT_REVOCABLE = "BILLING_COMPLIMENTARY_NOT_REVOCABLE";

// GET /api/v1/platform/billing/complimentary — every open arrangement (and
// those finished in the last 30 days), for the console.
export interface PlatformComplimentaryListResponse {
  grants: (PlatformComplimentaryGrantView & { tenantId: string; businessName: string })[];
  // COMPLIMENTARY businesses with no grant on record.
  legacyComplimentary: number;
}

// GET  /api/v1/platform/billing/reconciliation-cases?status=OPEN|RESOLVED
// POST /api/v1/platform/billing/reconciliation-cases/:caseId/resolve
export interface PlatformReconciliationCaseListResponse {
  cases: PlatformReconciliationCase[];
}

// POST /api/v1/platform/billing/reconcile
export interface PlatformReconciliationRunResponse {
  subscriptionsChecked: number;
  casesOpened: number;
  checkoutsExpired: number;
  // SC3e-1 — invoices added to (or updated in) the billing history.
  invoicesRecorded: number;
  // SC3e-3 — refunds or credits found made directly at the provider.
  externalAdjustmentsRecorded: number;
}

// POST /api/v1/platform/billing/enforcement/sweep (SC3c-1) — applies due
// grace and trial-recovery expiries now. With BILLING_ENFORCEMENT_ENABLED
// off it changes nothing ("enabled": false).
export interface PlatformBillingEnforcementSweepResponse {
  enabled: boolean;
  applied: number;
  failed: number;
}

// GET /api/v1/platform/plans
export interface PlatformPlanListResponse {
  plans: PlatformPlan[];
  subscriptions: { total: number };
}

// POST /api/v1/platform/plans — a new plan with a DRAFT version 1.
//   409 PLAN_KEY_TAKEN
export interface PlatformPlanCreateRequest {
  // 2–50: lowercase letters/digits in hyphen-separated words.
  key: string;
  // 2–80 characters.
  name: string;
  description?: string | null;
  moduleKeys: OptionalModuleKey[];
}

// POST /api/v1/platform/plans/:planId/versions — a new DRAFT version
// (copying the given modules); 409 PLAN_DRAFT_EXISTS while one is open.
// PUT  /api/v1/platform/plans/:planId/versions/:versionId — edit a DRAFT's
// modules; 409 PLAN_VERSION_NOT_DRAFT once published.
export interface PlatformPlanVersionModulesRequest {
  moduleKeys: OptionalModuleKey[];
}

// POST …/versions/:versionId/publish — DRAFT -> PUBLISHED (then immutable).
// POST …/versions/:versionId/retire  — PUBLISHED -> RETIRED: no longer
// offered; businesses already on it keep it until moved.

export type PlatformSubscriptionEventType =
  | "PLAN_ASSIGNED"
  | "PLAN_CHANGED"
  | "ADDON_GRANTED"
  | "ADDON_REVOKED"
  // SC3a — billing lifecycle.
  | "TRIAL_STARTED"
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_FAILED"
  | "GRACE_EXPIRED"
  | "TRIAL_EXPIRED"
  | "CANCEL_SCHEDULED"
  | "CANCEL_UNDONE"
  | "CANCELED"
  | "PLAN_CHANGE_PENDING"
  | "PLAN_CHANGE_APPLIED"
  | "PLAN_CHANGE_ABANDONED"
  // SC3c-1 — enforcement.
  | "RECOVERY_EXPIRED"
  | "BILLING_SUSPENDED"
  | "BILLING_SUSPENSION_LIFTED"
  // SC3c-2 — an ended subscription replaced by a new, paid one.
  | "SUBSCRIPTION_REPLACED"
  // SC3c-3 — operator grace extensions / exceptions.
  | "GRACE_EXTENDED"
  | "GRACE_EXCEPTION_GRANTED"
  | "GRACE_EXCEPTION_EXPIRED"
  // SC3e-2 — complimentary grants.
  | "COMPLIMENTARY_SCHEDULED"
  | "COMPLIMENTARY_STARTED"
  | "COMPLIMENTARY_WITHDRAWN"
  | "COMPLIMENTARY_ENDED"
  // SC3e-4 — payment setup.
  | "PAYMENT_SETUP_REQUIRED"
  | "PAYMENT_SETUP_WINDOW_STARTED"
  | "PAYMENT_SETUP_EXTENDED"
  | "PAYMENT_SETUP_EXPIRED"
  | "PAYMENT_SETUP_COMPLETED";

// SC3a — the subscription's billing state (separate from a business's
// administrative/security suspension). A COMPLIMENTARY subscription is never
// billed (Founding businesses).
export type PlatformSubscriptionStatus =
  | "ACTIVE"
  | "TRIALING"
  | "PAST_DUE"
  | "UNPAID"
  | "TRIAL_EXPIRED"
  | "CANCELED";
export type PlatformBillingMode = "COMPLIMENTARY" | "BILLED";

export interface PlatformTenantSubscription {
  id: string;
  status: PlatformSubscriptionStatus;
  billingMode: PlatformBillingMode;
  startedAt: string;
  plan: { id: string; key: string; name: string };
  version: { id: string; version: number; status: PlatformPlanVersionStatus };
  addOns: OptionalModuleKey[];
}

// GET /api/v1/platform/tenants/:tenantId/subscription
export interface PlatformTenantSubscriptionResponse {
  tenantId: string;
  // null: no subscription — the business has core only.
  subscription: PlatformTenantSubscription | null;
  // What the business can use now (always includes "core").
  modules: SubscriptionModuleKey[];
  // Most recent first (up to 20).
  history: Array<{
    type: PlatformSubscriptionEventType;
    at: string;
    fromVersion: string | null;
    toVersion: string | null;
    moduleKey: OptionalModuleKey | null;
  }>;
}

// POST /api/v1/platform/tenants/:tenantId/subscription/preview — what a
// change WOULD do, without making it (exactly one of the three).
export interface PlatformSubscriptionChangeRequest {
  planVersionId?: string;
  grant?: OptionalModuleKey;
  revoke?: OptionalModuleKey;
}

export interface PlatformSubscriptionPreviewResponse {
  current: SubscriptionModuleKey[];
  proposed: SubscriptionModuleKey[];
  gained: SubscriptionModuleKey[];
  lost: SubscriptionModuleKey[];
}

// PUT    /api/v1/platform/tenants/:tenantId/subscription {planVersionId}
//        assign or change the plan (a PUBLISHED version only; add-ons stay)
// POST   /api/v1/platform/tenants/:tenantId/subscription/add-ons {moduleKey}
// DELETE /api/v1/platform/tenants/:tenantId/subscription/add-ons/:moduleKey
// A request for the current state changes nothing (`changed: false`).
export interface PlatformSubscriptionChangeResponse
  extends PlatformTenantSubscriptionResponse {
  changed: boolean;
}

// --- Admin: internal user access review (Milestone 5E-1) --------------
// The business-facing read model for the Administration → Users screens.
// Served only from `/api/v1/admin/internal-users*` (InternalAuthGuard +
// PermissionGuard + `users.view`, CORPORATE-only). Deliberately exposes NO
// externalProvider / externalSubject / scopeId / raw permission keys /
// assignment ids — an administrator answers "who has access, are they
// active, what can they do, where" without RBAC vocabulary.

// Where a person can operate, as a whole:
//   all      — they hold at least one corporate role assignment.
//   selected — only specific locations (the union of their location
//              assignments), resolved to names.
//   none     — they have no role assignments at all.
// This reflects the SCOPE of their assignments, not a per-permission
// intersection — see the "What they can do" list for per-capability detail.
export type AdminUserLocationAccess =
  | { kind: "all" }
  | { kind: "selected"; locations: { id: string; name: string }[] }
  | { kind: "none" };

export interface AdminInternalUserSummary {
  id: string;
  displayName: string | null;
  email: string;
  status: InternalUserStatus;
  // The display names of the roles assigned to this person (deduplicated;
  // a role held at several locations appears once). Empty when the person
  // has no role assignments.
  accessLevels: string[];
  locationAccess: AdminUserLocationAccess;
}

// One heading of the "What they can do" list, with its plain-language
// lines. Groups with no lines are omitted entirely.
export interface AdminUserCapabilityGroup {
  group: string;
  items: string[];
}

export interface AdminInternalUserDetail extends AdminInternalUserSummary {
  // Derived from the SAME effective-authorization resolution the guards use
  // (permission + scope), never from a role name. Empty when the person has
  // no effective permissions.
  capabilities: AdminUserCapabilityGroup[];
  // The CONCRETE access grants this person holds (Milestone 5E-4). A person
  // who holds an access level at three locations has three entries here,
  // each independently removable. Ordered corporate-first, then by location
  // name. Empty when the person has no assignments.
  assignments: AdminInternalUserAccessAssignment[];
}

// --- Admin: access level + location assignment (Milestone 5E-4) ------
// One concrete access grant: an access level (InternalRole) applied either
// to every location (corporate) or to exactly one location. Deliberately
// exposes no scope-type enum, no scopeId, no role key, no permission keys —
// an administrator works in "access level / where" terms.
export interface AdminInternalUserAccessAssignment {
  id: string;
  accessLevel: { id: string; displayName: string; isBuiltIn: boolean };
  // The single location this grant applies to, or null when it applies to
  // every location.
  location: { id: string; name: string } | null;
  isCorporate: boolean;
}

// Where an access level may be applied, derived from the capabilities it
// contains (their allowed scope types) and, for the access levels the
// platform ships with, a fixed policy — never from the role's name as an
// authorization input.
//   "corporate-only" — applies to every location; no location choice.
//   "location-only"  — applies to chosen locations; at least one required.
export type AdminAccessAssignmentShape = "corporate-only" | "location-only";

export interface AdminAssignableAccessLevel {
  id: string;
  displayName: string;
  description: string | null;
  isBuiltIn: boolean;
  assignmentShape: AdminAccessAssignmentShape;
  // Plain-language, scope-agnostic summary of what this access level
  // allows — the same wording the access-level detail screen shows.
  capabilities: AdminUserCapabilityGroup[];
}

// GET /api/v1/admin/internal-users/access-options — the picker data for
// granting access. Gated by `users.manage_roles` (CORPORATE-only); holding
// it is sufficient, `roles.view` is NOT additionally required. `locations`
// is the active locations only.
export interface AdminAccessAssignmentOptions {
  accessLevels: AdminAssignableAccessLevel[];
  locations: { id: string; name: string }[];
}

// POST /api/v1/admin/internal-users/:internalUserId/role-assignments —
// grant an access level (`users.manage_roles`, CORPORATE-only, audited).
// The client never sends permission keys, a role key, a scope enum or
// assignment tuples: only an access level, where it applies, and why.
//   scope.kind "corporate" — apply to every location (no locationIds).
//   scope.kind "locations" — apply to each location (>= 1, de-duplicated;
//                            each must exist and be active).
export interface AdminAssignInternalUserRoleRequest {
  roleId: string;
  scope:
    | { kind: "corporate" }
    | { kind: "locations"; locationIds: string[] };
  reason: string;
}

// POST /api/v1/admin/internal-users/:internalUserId/role-assignments/:assignmentId/remove
// — remove ONE concrete access grant (`users.manage_roles`, CORPORATE-only,
// audited). Removing one location's grant never touches the person's other
// locations. `reason` is required.
export interface AdminRemoveInternalUserRoleAssignmentRequest {
  reason: string;
}

// --- Admin: activity log (Milestone 5F) -----------------------------
// The business-facing, read-only projection of InternalAuditEvent. Served
// only from `GET /api/v1/admin/audit` (InternalAuthGuard + PermissionGuard
// + `audit.view`, CORPORATE-only). The API constructs every field
// explicitly — it NEVER returns a raw audit row, `beforeData` / `afterData`,
// a raw `action` / `targetType` string, or any UUID other than the opaque
// event id / actor id.
export type AdminAuditActivityType =
  | "admin_access_status_changed"
  | "admin_access_granted"
  | "admin_access_removed";

export interface AdminAuditEventSummary {
  // Opaque event id — also the forward-pagination cursor.
  id: string;
  // ISO 8601 timestamp of when the activity happened.
  occurredAt: string;
  // The business category. A row whose stored action is not recognised is
  // still returned, projected as a safe generic activity (see
  // `activityLabel`) but with no `activityType` — clients must tolerate a
  // value outside the union or, in practice, filter on the ones they know.
  activityType: AdminAuditActivityType | "other";
  // A complete plain-language sentence, e.g.
  // "Nasser gave Sarah Store Manager access for Dearborn Heights".
  activityLabel: string;
  actor: { id: string; name: string; email: string };
  // Who the activity was about, already resolved to a display label.
  subject: { kind: "admin_user"; label: string };
  // Present only for location-scoped access changes.
  location: { name: string } | null;
  reason: string;
  // Small, business-worded extra lines for inline disclosure (e.g. previous
  // / new access state on a status change). Empty for most events.
  details: { label: string; value: string }[];
}

export interface AdminAuditEventPage {
  events: AdminAuditEventSummary[];
  // Forward cursor: pass as `?cursor=` to fetch the next (older) page.
  // Null when there are no older events in the current filtered set.
  nextCursor: string | null;
}

export interface AdminAuditFilterOptions {
  activityTypes: { value: AdminAuditActivityType; label: string }[];
}

// --- Admin: platform status (Milestone 5G) --------------------------
// A small, read-only, business-facing view of the platform's current
// high-level posture. Served only from `GET /api/v1/admin/platform/status`
// (InternalAuthGuard + PermissionGuard + `platform.view`, CORPORATE-only).
//
// It is INFORMATIONAL ONLY — there is no write endpoint and no persisted
// configuration. Every field is constructed explicitly from information the
// application already holds (provider mode, the payment boundary, aggregate
// location counts). It NEVER exposes a secret, credential, connection
// string, ARN, pool/client id, raw environment-variable name or value, or
// any other infrastructure identifier — `label` fields carry plain business
// language, not implementation detail.
export interface AdminPlatformStatus {
  // "Development" or "Production".
  environmentLabel: string;
  isProduction: boolean;
  authentication: {
    // e.g. "Amazon Cognito" or "Local development authentication".
    adminLabel: string;
    customerLabel: string;
  };
  payments: {
    // e.g. "Development payment provider" or "Live payment provider".
    providerLabel: string;
    isDevelopmentStandIn: boolean;
  };
  locations: {
    activeCount: number;
    inactiveCount: number;
    // Among ACTIVE locations only.
    digitalOrderingEnabledCount: number;
    digitalOrderingDisabledCount: number;
  };
}

// --- Admin: access levels (roles) review (Milestone 5E-2) ------------
// The business-facing read model for the Administration → Access Levels
// screens. Served only from `/api/v1/admin/internal-roles*` (InternalAuthGuard
// + PermissionGuard + `roles.view`, CORPORATE-only). An "access level" is an
// InternalRole; this contract deliberately exposes no role key, no raw
// permission keys, and no assignment rows.
export interface AdminRoleSummary {
  id: string;
  displayName: string;
  description: string | null;
  // Presentation metadata only, mapped from InternalRole.isSystem. It marks
  // a role the platform ships with — it currently confers and enforces
  // NOTHING (no edit protection exists yet).
  isBuiltIn: boolean;
  // The number of distinct people who hold this access level (a person who
  // holds it at several locations counts once).
  userCount: number;
}

export interface AdminRoleDetail extends AdminRoleSummary {
  // What this access level ALLOWS, in plain language — the capability
  // template, scope-agnostic ("View orders", not "…at all locations").
  // Only groups/items backed by a KNOWN permission on the role appear;
  // unknown stored permission keys are omitted (fail-closed).
  capabilities: AdminUserCapabilityGroup[];
}

// --- Admin: internal user status management (Milestone 5E-3) ---------
// PATCH /api/v1/admin/internal-users/:id/status — a highly privileged,
// audited write (`users.manage_status`, CORPORATE-only). Only these three
// statuses are settable: INVITED is never accepted here (invitation /
// activation is a later slice), and DISABLED is terminal (a disabled
// account can only be viewed, never re-enabled through this endpoint).
// `reason` is REQUIRED for every change and is stored on the audit event.
// The response is the updated AdminInternalUserDetail so the screen can
// refresh in place.
export interface AdminUpdateInternalUserStatusRequest {
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  reason: string;
}

// --- Internal authorization: permissions & scope (Milestone 5B) --------
// The CLOSED permission vocabulary. This is the single source of truth for
// what internal/Admin capabilities exist: a permission string only grants
// anything if server code checks that exact key, so roles configured in the
// database can never invent an unimplemented capability — they can only
// select from this list. Roles and role→permission and user→role→scope
// assignments are database data; this vocabulary is code.
//
// Keep this minimal: only permissions a CURRENT Admin route needs, or one
// approved to land alongside its slice. `locations.edit` is the single
// deliberate exception — an approved Milestone 5D product decision that is
// declared here in 5D-1 but not wired to a route until 5D-2, so the
// vocabulary and the seed role sync are ready. This is not licence to
// pre-declare a speculative future catalog.
export const INTERNAL_PERMISSION_KEYS = [
  "orders.view",
  "orders.manage_status",
  // R1 / S5b — reject or cancel an order. Separate from manage_status on
  // purpose: closing an order reverses gift-card, loyalty and promotion
  // effects and creates a refund obligation, so it is granted explicitly.
  "orders.cancel",
  "catalog.products.edit",
  "catalog.menu.manage",
  "catalog.overrides.manage",
  "catalog.view",
  "locations.view",
  "locations.edit",
  // SC4d — create a location. CORPORATE-only; SC4d allows a business its
  // first location only (the rule lives in the service, not the key).
  "locations.create",
  "locations.manage_digital_ordering",
  "users.view",
  "roles.view",
  "users.manage_status",
  // Milestone 5E-4
  "users.manage_roles",
  // Milestone 5F
  "audit.view",
  // Milestone 5G
  "platform.view",
  // Milestone 6A
  "operations.view",
  // Milestone 6B
  "operations.tasks.complete",
  // Milestone 6B-2
  "operations.checklists.configure",
  // Milestone 6C
  "operations.exceptions.manage",
  // Milestone 7A — Mocha Beans (loyalty). Both CORPORATE-only: a Mocha Bean
  // balance is company-wide, not location-scoped, and manual adjustment is
  // a highly sensitive HQ action a Store Manager never holds.
  "loyalty.view",
  "loyalty.adjust",
  // Milestone 7B — HQ loyalty configuration: the company-wide earning rate
  // and the Rewards Catalog. Milestone 7D also reuses this key for Bonus
  // Mocha Bean Promotions. CORPORATE-only; a Store Manager never holds it.
  "loyalty.configure",
  // Milestone 7E — HQ management of Promotions & Coupons (the regular
  // merchandise-discount system). A company-wide pricing capability;
  // CORPORATE-only, and a Store Manager never holds it.
  "promotions.configure",
  // Milestone 7F — Gift Card Foundation & Administration. A gift card is
  // company-wide stored value, so all three keys are CORPORATE-only and a
  // Store Manager never holds them.
  //   giftcards.view      — search/find, view detail, balance, status,
  //                         transaction history.
  //   giftcards.manage    — issue an HQ gift card, deactivate / reactivate,
  //                         perform an authorized manual balance correction
  //                         (a required reason, audited). Highly privileged.
  //   giftcards.configure — view/update the gift-card purchasing
  //                         configuration (preset amounts, custom-amount
  //                         enabled/disabled).
  "giftcards.view",
  "giftcards.manage",
  "giftcards.configure",
  // Milestone 8A — HQ CRM. A Mocha House customer is a company-wide record,
  // so both keys are CORPORATE-only and a Store Manager never holds them.
  //   customers.view          — the HQ customer directory + an individual
  //                             customer's aggregated profile / status /
  //                             loyalty / gift-card / order / preference
  //                             summary and CRM notes (all read-only).
  //   customers.notes.manage  — add an internal CRM note to a customer.
  "customers.view",
  "customers.notes.manage",
  // Milestone 8B — HQ Careers / Job Openings. A job opening is a
  // company-wide record (even when tied to one location), so both keys are
  // CORPORATE-only and a Store Manager never holds them.
  //   careers.view    — view job openings in Admin (draft / published /
  //                     archived) and their detail.
  //   careers.manage  — create, edit, publish, unpublish and archive a job
  //                     opening.
  "careers.view",
  "careers.manage",
  // Milestone 8C — Applicants. Applicant / application records contain
  // candidate PII, so both keys are CORPORATE-only and a Store Manager
  // never holds them.
  //   applicants.view    — read applicant / application records and notes.
  //   applicants.manage  — change an application's status and add an
  //                        internal applicant note.
  "applicants.view",
  "applicants.manage",
  // Milestone 8D — Franchising inquiries. A franchise prospect's contact
  // details are PII, so both keys are CORPORATE-only and a Store Manager
  // never holds them.
  //   franchising.view    — read franchise inquiries and their notes.
  //   franchising.manage  — change an inquiry's status and add an internal
  //                         note.
  "franchising.view",
  "franchising.manage",
  // Milestone S0D-2C-3 — tenant-owned notification recipient routing (which
  // address receives a Careers/Franchising business notification). Both
  // keys are CORPORATE-only: this is HQ configuration, not a per-location
  // concern, and a Store Manager never holds them.
  //   notifications.routing.view    — read the current tenant's configured
  //                                   notification recipients.
  //   notifications.routing.manage  — create/update a notification
  //                                   recipient for the current tenant.
  "notifications.routing.view",
  "notifications.routing.manage",
  // Milestone 8E — CMS foundation. Public site content is a company-wide
  // concern, so both keys are CORPORATE-only.
  //   cms.view    — read managed content pages (draft + published).
  //   cms.manage  — save draft content and publish a page.
  "cms.view",
  "cms.manage",
  // Milestone 8F — Media Library. Uploaded images are shared, company-wide
  // assets, so both keys are CORPORATE-only.
  //   media.view    — browse the media library.
  //   media.manage  — upload a new asset and deactivate an unused one.
  "media.view",
  "media.manage",
  // Milestone 8G — Marketing Campaigns. A thin HQ organizing layer over
  // existing Promotions / Loyalty Bonus Promotions / Products / Media — a
  // company-wide concern, so both keys are CORPORATE-only.
  //   marketing.view    — read campaigns and their detail.
  //   marketing.manage  — create/edit a campaign, change its status, and
  //                       manage its featured products.
  "marketing.view",
  "marketing.manage",
  // Milestone 8J — Approvals. A generic request/decide primitive; the only
  // workflow wired to it in this slice is Marketing Campaign activation.
  // Both CORPORATE-only.
  //   approvals.view    — list/see approval requests and their detail.
  //   approvals.decide  — approve or reject a pending request.
  "approvals.view",
  "approvals.decide",
  // Milestone 9A — HQ Reporting & Management Visibility. Read-only, and
  // company-wide by nature (a report spans every location unless the caller
  // narrows it), so CORPORATE-only; a Store Manager never holds it.
  //   reports.view — view HQ reporting (Milestone 9A: Digital Sales &
  //                  Orders). One key covers every report in this area —
  //                  reports are read-only, so there is no separate
  //                  "manage" action, and no per-report key is warranted.
  "reports.view",
  // SC3b — the business's own CENTERIVO subscription billing (core). view:
  // its plan, price and billing state; manage: open Checkout to set up
  // payment. Never anything about restaurant customer payments.
  "billing.view",
  "billing.manage",
  // ESP-04 M1 — the restaurant's OWN customer-payment account (Stripe
  // Connect): connect it, continue its hosted onboarding and refresh its
  // status. Corporate-only and held only by the built-in administrator
  // (owner) role; the API also requires that role. Never anything about
  // CENTERIVO subscription billing.
  "payments.connect",
] as const;

export type InternalPermissionKey = (typeof INTERNAL_PERMISSION_KEYS)[number];

// SC1d — the built-in staff roles every business starts with, defined ONCE
// and used by both the seed (Tenant #1) and business provisioning, so the
// two can never drift apart. Permission lists are copied into each business
// when its role is created; later changes in the Administration area are
// that business's own.
export interface BuiltInInternalRole {
  key: string;
  displayName: string;
  description: string;
  permissionKeys: readonly InternalPermissionKey[];
}

// Every permission, at corporate scope: the business's full administrator
// (and its first owner). Key kept for compatibility with Tenant #1.
export const PLATFORM_ADMINISTRATOR_ROLE: BuiltInInternalRole = {
  key: "platform-administrator",
  displayName: "Platform Administrator",
  description:
    "Built-in role holding every internal permission. Granted at corporate scope for platform operators.",
  permissionKeys: INTERNAL_PERMISSION_KEYS,
};

// Runs a location day to day: orders, online ordering, and location price /
// availability for the locations it is assigned to. Deliberately no catalog
// editing, menu composition, location editing, user / role administration
// or gift-card administration (a CORPORATE-only HQ function).
export const STORE_MANAGER_ROLE: BuiltInInternalRole = {
  key: "store-manager",
  displayName: "Store Manager",
  description:
    "Manages day-to-day orders, online ordering, prices and availability for assigned locations.",
  permissionKeys: [
    "locations.view",
    "orders.view",
    "orders.manage_status",
    // R1 / S5b — reject or cancel an order at their locations. Inert while
    // ORDER_CLOSURE_ENABLED is off.
    "orders.cancel",
    "catalog.overrides.manage",
    "locations.manage_digital_ordering",
    // Milestones 6A–6C — Store Operations for their locations.
    "operations.view",
    "operations.tasks.complete",
    "operations.exceptions.manage",
  ],
};

export const BUILT_IN_INTERNAL_ROLES: readonly BuiltInInternalRole[] = [
  PLATFORM_ADMINISTRATOR_ROLE,
  STORE_MANAGER_ROLE,
];

// --- CENTERIVO SaaS: module catalog (SC2a) ------------------------------
// The ONE definition of what a subscription plan can include. Every staff
// permission belongs to exactly one module (PERMISSION_MODULE is an
// exhaustive Record, so a new permission cannot be added unclassified).
// "core" is ALWAYS included: account management, administration, orders,
// catalog, locations, reports — everything a business needs to run, recover
// access and reconcile money. A business with no subscription has core only.
//
// SaaS subscriptions are platform data. They are entirely separate from a
// business's customer payments (orders / PaymentAttempt) and never share a
// provider, table or configuration with them.

export type SubscriptionModuleKey =
  | "core"
  | "operations"
  | "loyalty"
  | "promotions"
  | "giftcards"
  | "crm"
  | "careers"
  | "franchising"
  | "cms"
  | "marketing";

// The modules a plan chooses (core is implicit and never listed).
export type OptionalModuleKey = Exclude<SubscriptionModuleKey, "core">;

export interface SubscriptionModule {
  key: SubscriptionModuleKey;
  label: string;
  description: string;
}

export const SUBSCRIPTION_MODULES: readonly SubscriptionModule[] = [
  {
    key: "core",
    label: "Core",
    description:
      "Orders, catalog and menus, locations, staff and roles, audit, approvals, media, notification routing and reports. Always included.",
  },
  { key: "operations", label: "Store operations", description: "Daily checklists, tasks and exceptions." },
  { key: "loyalty", label: "Loyalty", description: "Points earning, rewards and bonus promotions." },
  { key: "promotions", label: "Promotions", description: "Discount promotions at checkout." },
  { key: "giftcards", label: "Gift cards", description: "Selling, redeeming and managing gift cards." },
  { key: "crm", label: "Customers", description: "Customer directory and notes." },
  { key: "careers", label: "Careers", description: "Job openings and applicants." },
  { key: "franchising", label: "Franchising", description: "Franchise inquiries." },
  { key: "cms", label: "Website content", description: "Website pages." },
  { key: "marketing", label: "Marketing", description: "Campaigns." },
];

export const OPTIONAL_MODULE_KEYS: readonly OptionalModuleKey[] = [
  "operations",
  "loyalty",
  "promotions",
  "giftcards",
  "crm",
  "careers",
  "franchising",
  "cms",
  "marketing",
];

export function isOptionalModuleKey(value: unknown): value is OptionalModuleKey {
  return (
    typeof value === "string" &&
    (OPTIONAL_MODULE_KEYS as readonly string[]).includes(value)
  );
}

export const PERMISSION_MODULE: Readonly<
  Record<InternalPermissionKey, SubscriptionModuleKey>
> = {
  "orders.view": "core",
  "orders.manage_status": "core",
  "orders.cancel": "core",
  "catalog.products.edit": "core",
  "catalog.menu.manage": "core",
  "catalog.overrides.manage": "core",
  "catalog.view": "core",
  "locations.view": "core",
  "locations.edit": "core",
  "locations.create": "core",
  "locations.manage_digital_ordering": "core",
  "users.view": "core",
  "roles.view": "core",
  "users.manage_status": "core",
  "users.manage_roles": "core",
  "audit.view": "core",
  "platform.view": "core",
  "notifications.routing.view": "core",
  "notifications.routing.manage": "core",
  "media.view": "core",
  "media.manage": "core",
  "approvals.view": "core",
  "approvals.decide": "core",
  "reports.view": "core",
  "billing.view": "core",
  "billing.manage": "core",
  "payments.connect": "core",
  "operations.view": "operations",
  "operations.tasks.complete": "operations",
  "operations.checklists.configure": "operations",
  "operations.exceptions.manage": "operations",
  "loyalty.view": "loyalty",
  "loyalty.adjust": "loyalty",
  "loyalty.configure": "loyalty",
  "promotions.configure": "promotions",
  "giftcards.view": "giftcards",
  "giftcards.manage": "giftcards",
  "giftcards.configure": "giftcards",
  "customers.view": "crm",
  "customers.notes.manage": "crm",
  "careers.view": "careers",
  "careers.manage": "careers",
  "applicants.view": "careers",
  "applicants.manage": "careers",
  "franchising.view": "franchising",
  "franchising.manage": "franchising",
  "cms.view": "cms",
  "cms.manage": "cms",
  "marketing.view": "marketing",
  "marketing.manage": "marketing",
};

// Lifecycle exceptions: permissions kept even when their module is NOT
// entitled (e.g. after a downgrade), so a business can still see and
// correct stored value it already holds — reconciliation and required
// refunds are never blocked by a plan change. Configuration and new
// activity in the module stay off. (Orders, refunds and payment
// reconciliation are core.)
export const LIFECYCLE_RETAINED_PERMISSIONS: readonly InternalPermissionKey[] = [
  "giftcards.view",
  "giftcards.manage",
  "loyalty.view",
  "loyalty.adjust",
];

// Whether a business with these entitled modules may use a permission
// (roles still decide who holds it).
export function isPermissionEntitled(
  key: InternalPermissionKey,
  modules: ReadonlySet<SubscriptionModuleKey>,
): boolean {
  const owner = PERMISSION_MODULE[key];
  return (
    owner === "core" ||
    modules.has(owner) ||
    LIFECYCLE_RETAINED_PERMISSIONS.includes(key)
  );
}

export const MODULE_NOT_ENTITLED = "MODULE_NOT_ENTITLED";

// SC2b — customer-facing (storefront) enforcement. The optional modules a
// customer can meet directly. CRM, operations and marketing have no public
// surface, so they are never reported to the storefront.
export const STOREFRONT_FEATURE_KEYS = [
  "loyalty",
  "promotions",
  "giftcards",
  "careers",
  "franchising",
  "cms",
] as const satisfies readonly OptionalModuleKey[];

export type StorefrontFeatureKey = (typeof STOREFRONT_FEATURE_KEYS)[number];

// A customer action the business's plan does not include: answered 403 with
// this code, always BEFORE any payment is attempted. A page that only
// exists for such a module (a job opening, a website-content page) is 404.
export const FEATURE_NOT_AVAILABLE = "FEATURE_NOT_AVAILABLE";

// ESP-03 PR 3 — the one 409 answer to a gift-card purchase step-2 request
// for a key with no purchase the caller may see: unknown, another
// business's, or not the caller's (no valid recovery credential, not the
// buyer). Identical in every case, so it reveals nothing about a payment;
// the storefront starts the purchase again.
export const GIFT_CARD_PURCHASE_NOT_FOUND = "GIFT_CARD_PURCHASE_NOT_FOUND";

export interface FeatureNotAvailableError {
  statusCode: 403;
  error: "Forbidden";
  code: typeof FEATURE_NOT_AVAILABLE;
  feature: StorefrontFeatureKey;
  message: string;
}

// GET /api/v1/storefront/features — no auth. Availability only, for the
// storefront's own (server-resolved) business: never the plan's name,
// prices or any other business's data.
// SC4f-3b — GET /api/v1/storefront/profile. No auth: what a storefront needs
// to present ITS OWN business (resolved by the server, never named by the
// browser). Public information only.
export interface StorefrontProfileResponse {
  businessName: string;
  // The business may take orders now: taking sales (not awaiting payment
  // setup) and at least one active location with online ordering on.
  // Location-level availability still applies; checkout re-checks
  // everything.
  orderingAvailable: boolean;
  // "Points" unless the business chose its own name. Presentation only.
  loyaltyPointsLabel: string;
  // "legacy": the business that keeps the original storefront presentation
  // (Mocha House), identified by trusted deployment configuration.
  presentation: "legacy" | "standard";
}

export const DEFAULT_LOYALTY_POINTS_LABEL = "Points";
export const LOYALTY_POINTS_LABEL_MAX = 32;

// GET/PUT /api/v1/admin/loyalty/settings/points-label (loyalty.configure).
export interface LoyaltyPointsLabelSettings {
  // The business's own label, or null for the default.
  pointsLabel: string | null;
  // What customers and staff see.
  effectivePointsLabel: string;
}

export interface UpdateLoyaltyPointsLabelRequest {
  // null or blank restores the default.
  pointsLabel: string | null;
}

export interface StorefrontFeaturesResponse {
  features: Record<StorefrontFeatureKey, boolean>;
}

// What the business admin knows about its own plan (GET /internal/me).
export interface InternalEntitlementsSummary {
  // Always includes "core".
  modules: SubscriptionModuleKey[];
  planName: string | null;
  // SC4b — a business its owner created that has not completed payment
  // setup: core only and no customer sales until billing (or a trial) is
  // verified by the billing provider.
  paymentSetupPending: boolean;
}

// SC4b — checkout refused (403) while the business may not take orders yet.
export const SALES_NOT_AVAILABLE = "SALES_NOT_AVAILABLE";

// Scope types the application currently supports operationally. The Prisma
// enum mirrors exactly this set — additional organizational scope types
// (location groups, franchise organizations) are added only when their
// domain models exist.
//
//   CORPORATE — assignment.scopeId is null; grants the permission for every
//               current location.
//   LOCATION  — assignment.scopeId is a Location id; grants the permission
//               for that one location only.
export const INTERNAL_SCOPE_TYPES = ["CORPORATE", "LOCATION"] as const;

export type InternalScopeType = (typeof INTERNAL_SCOPE_TYPES)[number];

export interface InternalPermissionMetadata {
  key: InternalPermissionKey;
  description: string;
  // The scope types through which this permission may be granted. A
  // permission held only through an assignment whose scopeType is not in
  // this list does NOT authorize the action. Master/global catalog
  // operations are CORPORATE-only precisely so a location-scoped manager
  // can never change a master product or menu for every store.
  allowedScopeTypes: readonly InternalScopeType[];
}

export const INTERNAL_PERMISSION_METADATA: Record<
  InternalPermissionKey,
  InternalPermissionMetadata
> = {
  "orders.view": {
    key: "orders.view",
    description: "View the store order queue and individual order detail.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "orders.manage_status": {
    key: "orders.manage_status",
    description: "Advance an order through its operational lifecycle.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "orders.cancel": {
    key: "orders.cancel",
    description:
      "Reject a new order or cancel an accepted one. Restores gift-card value, reverses Mocha Beans and promotion usage, and records any card refund as owed (never refunds a card itself).",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "catalog.products.edit": {
    key: "catalog.products.edit",
    description:
      "Edit a master product (name, description, base price, active state). Affects every location.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "catalog.menu.manage": {
    key: "catalog.menu.manage",
    description:
      "Change which products appear on a menu. Menus are shared across locations.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "catalog.overrides.manage": {
    key: "catalog.overrides.manage",
    description:
      "Set or clear a location's price and availability overrides.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "catalog.view": {
    key: "catalog.view",
    description:
      "View the master product catalog in Admin, including inactive products. The catalog is shared across every location, so this is a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "locations.view": {
    key: "locations.view",
    description:
      "View Admin location records (including inactive) within the granted scope. A LOCATION grant sees only its own locations; a CORPORATE grant sees all.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "locations.edit": {
    key: "locations.edit",
    description:
      "Edit a location record (name, active state). A corporate-scoped operation.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "locations.create": {
    key: "locations.create",
    description:
      "Create a location for the business. A corporate-scoped operation.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "locations.manage_digital_ordering": {
    key: "locations.manage_digital_ordering",
    description: "Toggle a location's digital-ordering availability.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "users.view": {
    key: "users.view",
    description:
      "View internal Admin users, their status, access levels and location access. User administration is a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "roles.view": {
    key: "roles.view",
    description:
      "View Admin access levels (roles) and the capabilities included in each. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "users.manage_status": {
    key: "users.manage_status",
    description:
      "Suspend, reactivate, or disable an internal Admin user. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "users.manage_roles": {
    key: "users.manage_roles",
    description:
      "Assign or remove internal-user access levels and their location scope. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "audit.view": {
    key: "audit.view",
    description:
      "View the Admin activity log — the recorded history of administrative access changes. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "platform.view": {
    key: "platform.view",
    description:
      "View platform status and configuration — a read-only, high-level view of the platform's environment, authentication, payment and location posture. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 6A — the entry point to the Store Operations workspace. Held
  // at CORPORATE (an operations user works across every store) or at
  // LOCATION (a store manager works their own stores). It gates only the
  // Operations area's read views; it never, on its own, grants any other
  // capability — order information shown there is still governed by
  // `orders.view`, exactly as on every other screen.
  "operations.view": {
    key: "operations.view",
    description:
      "View the Store Operations workspace for a location — the day's operational picture. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 6B — complete (and undo) operational checklist/task items for
  // an authorized location. This is the first Operations *write*. It never
  // grants viewing on its own (`operations.view` still gates the workspace)
  // and, like `operations.view`, is held at corporate (an operations user
  // working across every store) or per location (a store manager).
  "operations.tasks.complete": {
    key: "operations.tasks.complete",
    description:
      "Complete operational checklist and task items for an authorized location. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 6B-2 — manage the corporate daily-checklist templates that
  // every location's daily checklist is created from (item wording, active
  // state, ordering, sections). Governs BOTH the Opening (6B-2) and Closing
  // (6D) checklist templates — there is one corporate standard per
  // checklist and no per-location override, so this is CORPORATE-only. It
  // is a configuration capability only: it never grants `operations.view`
  // or `operations.tasks.complete`, and completing a store's daily
  // checklist still requires `operations.tasks.complete`.
  "operations.checklists.configure": {
    key: "operations.checklists.configure",
    description:
      "Manage the corporate Opening and Closing Checklist templates — item wording, active state, ordering and sections. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 6C — log and clear a Management Exception on a daily-checklist
  // item (Opening or Closing since 6D): a manager-authorized way to RESOLVE
  // an item that could not actually be completed, with a required reason.
  // It is deliberately separate from `operations.tasks.complete` — waiving
  // a standard requirement is a management decision, not a routine tick,
  // and it is audited. Held at corporate (an operations user across every
  // store) or per location (a store manager for their store).
  "operations.exceptions.manage": {
    key: "operations.exceptions.manage",
    description:
      "Log and clear a management exception on a daily-checklist item for an authorized location. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 7A — Mocha Beans (loyalty). A Bean balance is a single
  // company-wide figure per customer, so both keys are CORPORATE-only.
  "loyalty.view": {
    key: "loyalty.view",
    description:
      "View a customer's Mocha Bean balance and the internal Bean transaction ledger. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "loyalty.adjust": {
    key: "loyalty.adjust",
    description:
      "Manually add or deduct a customer's Mocha Beans, with a required reason. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "loyalty.configure": {
    key: "loyalty.configure",
    description:
      "Configure the standard company-wide Mocha Bean earning rate, manage the customer Rewards Catalog, and manage Bonus Mocha Bean Promotions. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "promotions.configure": {
    key: "promotions.configure",
    description:
      "Create and manage Promotions & Coupons (the regular merchandise-discount system). A company-wide pricing capability; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 7F — Gift Cards. A gift card is company-wide stored value, so
  // every key is CORPORATE-only; a Store Manager never holds them.
  "giftcards.view": {
    key: "giftcards.view",
    description:
      "Search for a gift card and view its detail — masked code, original value, current balance, active/inactive status and transaction history. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "giftcards.manage": {
    key: "giftcards.manage",
    description:
      "Issue an HQ gift card, deactivate or reactivate a gift card, and make an authorized manual balance correction with a required reason. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "giftcards.configure": {
    key: "giftcards.configure",
    description:
      "View and update the gift-card purchasing configuration — preset purchase amounts and whether custom amounts are allowed. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "customers.view": {
    key: "customers.view",
    description:
      "View the HQ customer directory and an individual customer's profile, contact details, account status and their loyalty / gift-card / order / preference summary and internal CRM notes. Read-only. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "customers.notes.manage": {
    key: "customers.notes.manage",
    description:
      "Add an internal CRM note to a customer record. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "careers.view": {
    key: "careers.view",
    description:
      "View job openings in Admin, including drafts and archived openings, and their detail. Read-only. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "careers.manage": {
    key: "careers.manage",
    description:
      "Create, edit, publish, unpublish and archive job openings. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "applicants.view": {
    key: "applicants.view",
    description:
      "View job applicants and individual applications, including candidate contact details and internal notes. Read-only. Candidate PII, so a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "applicants.manage": {
    key: "applicants.manage",
    description:
      "Change a job application's status and add an internal applicant note. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "franchising.view": {
    key: "franchising.view",
    description:
      "View franchise inquiries and their internal notes. Read-only. Prospect PII, so a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "franchising.manage": {
    key: "franchising.manage",
    description:
      "Change a franchise inquiry's status and add an internal note. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "notifications.routing.view": {
    key: "notifications.routing.view",
    description:
      "View the current tenant's configured notification recipients (which address receives a Careers/Franchising business notification) and the read-only health of notification delivery. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "notifications.routing.manage": {
    key: "notifications.routing.manage",
    description:
      "Create or update a notification recipient for the current tenant. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "cms.view": {
    key: "cms.view",
    description:
      "View managed public content pages, including draft content. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "cms.manage": {
    key: "cms.manage",
    description:
      "Save draft content and publish a managed public content page. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "media.view": {
    key: "media.view",
    description: "Browse the media library. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "media.manage": {
    key: "media.manage",
    description:
      "Upload a new media asset and deactivate an unused one. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "marketing.view": {
    key: "marketing.view",
    description:
      "View marketing campaigns and their detail. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "marketing.manage": {
    key: "marketing.manage",
    description:
      "Create and edit marketing campaigns, change campaign status, and manage a campaign's featured products. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "approvals.view": {
    key: "approvals.view",
    description:
      "View approval requests and their detail. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "approvals.decide": {
    key: "approvals.decide",
    description:
      "Approve or reject a pending approval request. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "reports.view": {
    key: "reports.view",
    description:
      "View HQ reporting — read-only, aggregated business figures. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "billing.view": {
    key: "billing.view",
    description:
      "View the business's CENTERIVO plan, price and billing status. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "billing.manage": {
    key: "billing.manage",
    description:
      "Set up the business's CENTERIVO subscription payment (hosted Checkout). A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "payments.connect": {
    key: "payments.connect",
    description:
      "Connect and manage the restaurant's own Stripe account for customer payments (owner only). A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
};

// --- Store Operations: the daily checklist view (Milestone 6B) ---------
// The business-facing view of one location's daily checklist for one
// business day. SHARED by the Opening Checklist (6B) and the Closing
// Checklist (6D) — the two are structurally identical; `title` carries the
// human name ("Opening Checklist" / "Closing Checklist"). Served only from
// the guarded `/api/v1/admin/operations/{opening,closing}-checklist*`
// routes (InternalAuthGuard + PermissionGuard + resource-level location
// scope). GET requires `operations.view`; Complete / Undo require
// `operations.tasks.complete`.
//
// The API constructs every field explicitly — it NEVER returns a raw Prisma
// model, a template id, an internal user id, a permission key, or a
// technical database field. `item.id` is an opaque action/resource id (the
// ChecklistInstanceItem id) and is the only identifier here.
//
// `businessDate` is `YYYY-MM-DD`, resolved in the Mocha House business
// timezone (America/Detroit). Sections and items are already ordered and
// come from the seeded corporate template.
//
// The `OpeningChecklist*` names are the established vocabulary (6B); they
// are the shared checklist contract, not opening-specific.
//
// RESOLUTION (Milestone 6C): an item is "resolved" when it is completed
// normally OR carries a management exception. `status` is the single source
// of truth for the UI; `completed` stays true ONLY for a normal completion
// so older callers keep their meaning. Progress is derived: `isComplete` is
// `resolved === total`.
export type OpeningChecklistItemStatus = "open" | "completed" | "exception";

export interface OpeningChecklistItemView {
  // Opaque ChecklistInstanceItem id — the target for Complete / Undo /
  // Log Exception / Clear Exception.
  id: string;
  label: string;
  status: OpeningChecklistItemStatus;
  // status !== "open" — the item no longer blocks the checklist.
  resolved: boolean;
  // TRUE only for a NORMAL completion (status === "completed"). An
  // exception-resolved item is `false` here — it must never render as an
  // ordinary completed checkmark.
  completed: boolean;
  // The current completion actor's display name, or null when not completed
  // normally. Undo clears this — only the CURRENT actor is kept, not a
  // history.
  completedBy: { name: string } | null;
  // ISO 8601 timestamp of the current normal completion, or null.
  completedAt: string | null;
  // Present only when status === "exception". The reason is required text;
  // `by` is the manager who logged it (null only if that user is missing);
  // `at` is the ISO 8601 timestamp. Cleared together by Clear Exception.
  exception: {
    reason: string;
    by: { name: string } | null;
    at: string;
  } | null;
}

export interface OpeningChecklistSectionView {
  name: string;
  items: OpeningChecklistItemView[];
}

export interface OpeningChecklistProgress {
  // Items completed NORMALLY.
  completed: number;
  // Items resolved by normal completion OR a management exception. This is
  // the number to show as "X of Y".
  resolved: number;
  total: number;
  // resolved === total (and total > 0). There is no readiness score.
  isComplete: boolean;
}

export interface OpeningChecklistResponse {
  locationId: string;
  locationName: string;
  businessDate: string;
  // The template name — "Opening Checklist".
  title: string;
  progress: OpeningChecklistProgress;
  sections: OpeningChecklistSectionView[];
}

// POST body for both
// `/api/v1/admin/operations/opening-checklist/items/:instanceItemId/complete`
// and `.../undo`. `locationId` is a REQUIRED filter — it is checked against
// the item's own instance, never trusted as proof of authorization.
export interface OpeningChecklistItemActionRequest {
  locationId: string;
}

// --- Store Operations: Management Exception (Milestone 6C) ------------
// POST `/api/v1/admin/operations/opening-checklist/items/:instanceItemId/exception`
// — requires `operations.exceptions.manage` for the location. Rejected
// (409) when the item is already completed normally. `reason` is required,
// trimmed, non-empty and at most 500 characters. Logging an exception is
// recorded as an InternalAuditEvent.
export interface LogOpeningChecklistExceptionRequest {
  locationId: string;
  reason: string;
}

// POST `.../items/:instanceItemId/exception/clear` — requires
// `operations.exceptions.manage`. Returns the item to "open". Also audited.
export interface ClearOpeningChecklistExceptionRequest {
  locationId: string;
}

// --- Store Operations: Today's Tasks (Milestone 6C) -----------------
// Simple, location-scoped operational to-dos for ONE America/Detroit
// business date. Served only from the guarded
// `/api/v1/admin/operations/tasks*` routes (InternalAuthGuard +
// PermissionGuard + resource-level location scope). GET requires
// `operations.view`; add / complete / reopen / delete require
// `operations.tasks.complete`.
//
// A task belongs only to `businessDate` — there is no rollover, no due
// time, no assignee, no priority, no category. "Open" vs "Done" is derived
// purely from completion state. Routine task actions are NOT audited.
export interface OperationsTaskView {
  // Opaque OperationsTask id — the target for the task actions.
  id: string;
  title: string;
  note: string | null;
  done: boolean;
  // Display name of who completed it, or null when open.
  completedBy: { name: string } | null;
  // ISO 8601 timestamp of completion, or null when open.
  completedAt: string | null;
  // Display name of the creator, or null only if that user is missing.
  createdBy: { name: string } | null;
  // ISO 8601 timestamp.
  createdAt: string;
}

export interface OperationsTasksResponse {
  locationId: string;
  locationName: string;
  businessDate: string;
  // Open tasks first (oldest first), then done tasks (oldest first).
  tasks: OperationsTaskView[];
  openCount: number;
  doneCount: number;
}

// POST `/api/v1/admin/operations/tasks` — `title` is required, trimmed,
// non-empty and at most 200 characters; `note` is optional, trimmed and at
// most 500 characters (an empty note is stored as null).
export interface CreateOperationsTaskRequest {
  locationId: string;
  title: string;
  note?: string;
}

// POST body for `/tasks/:taskId/complete`, `/tasks/:taskId/reopen` and
// `/tasks/:taskId/delete`. `locationId` is a REQUIRED filter, checked
// against the task's own location and business date, never trusted as
// proof of authorization.
export interface OperationsTaskActionRequest {
  locationId: string;
}

// --- Store Operations: HQ Opening Checklist configuration (6B-2) -------
// The corporate configuration view of the ONE Opening Checklist template
// that every location's daily checklist instance is created from. Served
// only from the guarded
// `/api/v1/admin/operations/opening-checklist/template*` routes
// (InternalAuthGuard + PermissionGuard + `operations.checklists.configure`,
// CORPORATE-only). There is no `locationId` anywhere here — one corporate
// standard, no per-location override.
//
// Configuration changes NEVER rewrite an already-created ChecklistInstance
// (instances snapshot every item by value at creation). They take effect
// the next time a location creates its Opening Checklist.
//
// Unlike the execution view, this view includes INACTIVE items — HQ needs
// to see and reactivate them. `id` is the opaque ChecklistTemplateItem id,
// the target for the item mutations.
export interface OpeningChecklistTemplateItemConfig {
  // Opaque ChecklistTemplateItem id.
  id: string;
  label: string;
  // Inactive items stay in configuration and can be reactivated, but are
  // left out of every newly created daily checklist.
  isActive: boolean;
  // True when this item can move further up / down within its own section.
  // Cross-section moves are not offered in 6B-2.
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface OpeningChecklistTemplateSectionConfig {
  name: string;
  // True when this section can move further up / down in the checklist.
  canMoveUp: boolean;
  canMoveDown: boolean;
  items: OpeningChecklistTemplateItemConfig[];
}

// GET /api/v1/admin/operations/opening-checklist/template
export interface OpeningChecklistTemplateConfigResponse {
  // The template name — "Opening Checklist".
  title: string;
  // Sections in corporate display order; items within each section in
  // corporate display order. A newly created daily checklist lists its
  // ACTIVE items in exactly this order.
  sections: OpeningChecklistTemplateSectionConfig[];
}

// PATCH /api/v1/admin/operations/opening-checklist/template/items/:itemId
// At least one field must be present. `label`, when present, is trimmed and
// must be non-empty. Toggling `isActive` never touches an existing
// instance.
export interface UpdateOpeningChecklistTemplateItemRequest {
  label?: string;
  isActive?: boolean;
}

// POST /api/v1/admin/operations/opening-checklist/template/items
// Adds one item to the end of `section`. `section` may name an existing
// section (matched case- and whitespace-insensitively) or a new one, in
// which case the new section is appended after the existing sections. The
// new item is created Active.
export interface AddOpeningChecklistTemplateItemRequest {
  section: string;
  label: string;
}

// POST .../template/items/:itemId/move  and  .../template/sections/move
// Simple one-step reorder. Item moves are within the item's current
// section only; a move past the first / last position is rejected.
export interface MoveOpeningChecklistTemplateItemRequest {
  direction: "up" | "down";
}

export interface MoveOpeningChecklistTemplateSectionRequest {
  // The section to move, by its current name.
  section: string;
  direction: "up" | "down";
}

// POST .../template/sections/rename
// Renames one section: every template item in `from` is moved to `to`.
// `to` is trimmed and must be non-empty and must not collide (case- and
// whitespace-insensitively) with another existing section. Existing
// ChecklistInstanceItem.section values are never touched.
export interface RenameOpeningChecklistTemplateSectionRequest {
  from: string;
  to: string;
}

// --- Admin: Mocha Beans / loyalty (Milestone 7A) ---------------------
// The smallest HQ surface over the Mocha Bean ledger: find a customer,
// read their balance and the internal ledger, and manually add/deduct
// Beans. All routes are InternalAuthGuard + PermissionGuard, CORPORATE-only
// (`loyalty.view` to read, `loyalty.adjust` to adjust). This is NOT a
// general customer-management module — it only ever exposes loyalty data.

// EARN and REDEEM are automatic (order-driven); MANUAL_ADJUSTMENT is an HQ
// action. REDEEM (Milestone 7C) is a negative entry for Beans spent on a
// reward.
//
// R1 / S5a adds the three reversal types a rejected or cancelled order can
// write (S5b): REDEEM_REVERSAL returns Beans (positive), EARN_REVERSAL and
// BONUS_EARN_REVERSAL recover them (negative). Nothing writes them yet.
export type MochaBeanLedgerEntryType =
  | "EARN"
  | "MANUAL_ADJUSTMENT"
  | "REDEEM"
  | "BONUS_EARN"
  | "REDEEM_REVERSAL"
  | "EARN_REVERSAL"
  | "BONUS_EARN_REVERSAL";

// One row of the internal Mocha Bean ledger, projected for HQ. `amount` is
// signed whole Beans. `actorLabel` is the HQ operator's name/email for a
// MANUAL_ADJUSTMENT, null for an automatic EARN / REDEEM. `orderNumber` is
// the human order reference for an EARN or REDEEM, null for a manual
// adjustment.
export interface AdminMochaBeanLedgerEntry {
  id: string;
  type: MochaBeanLedgerEntryType;
  amount: number;
  reason: string | null;
  orderNumber: string | null;
  actorLabel: string | null;
  createdAt: string;
}

// A customer as it appears on the HQ loyalty surface — identity plus the
// current materialized balance. `balance` is 0 for a customer who has
// never earned or been adjusted (no ledger account yet).
export interface AdminLoyaltyCustomer {
  id: string;
  email: string | null;
  displayName: string | null;
  status: CustomerAccountStatus;
  balance: number;
}

// GET /api/v1/admin/loyalty/customers?query=<email or customer id>
// A deliberately narrow lookup: an exact (case-insensitive) email match or
// an exact customer-id match. No fuzzy search, no listing-all.
export interface AdminLoyaltyCustomerSearchResponse {
  customers: AdminLoyaltyCustomer[];
}

// GET /api/v1/admin/loyalty/customers/:customerId
export interface AdminLoyaltyCustomerDetail {
  customer: AdminLoyaltyCustomer;
  entries: AdminMochaBeanLedgerEntry[];
}

// POST /api/v1/admin/loyalty/customers/:customerId/adjustments
// `deltaBeans` is a non-zero whole integer (positive to add, negative to
// deduct). `reason` is required, trimmed, non-empty. `operationKey` is a
// caller-supplied idempotency key (8-200 chars) — retrying the same key
// never applies the adjustment twice. The resulting balance may never go
// below zero.
export interface AdminAdjustMochaBeansRequest {
  deltaBeans: number;
  reason: string;
  operationKey: string;
}

// --- Admin: Gift Card Foundation & Administration (Milestone 7F) ------
// The HQ gift-card surface. All routes are InternalAuthGuard +
// PermissionGuard, CORPORATE-only:
//   giftcards.view      — POST /search, GET /:id
//   giftcards.manage    — POST / (issue), POST /:id/deactivate,
//                         POST /:id/reactivate, POST /:id/corrections
//   giftcards.configure — GET /configuration, PUT /configuration
// This is NOT customer purchasing or checkout redemption — see the schema
// comment on GiftCard. The full gift-card code is returned exactly once, in
// the issuance response; every other projection exposes only a masked code
// and the last 4 characters. The full code never appears in a URL, query
// string, audit record or log.

// The approved monetary ceiling for a gift card's value / balance and for
// any single preset purchase amount, in integer minor units ($2,000.00).
export const GIFT_CARD_MAX_VALUE_MINOR_UNITS = 200_000;

export type GiftCardStatus = "ACTIVE" | "INACTIVE";

// 7F writes ISSUANCE / ADJUSTMENT; Milestone 7G adds REDEMPTION (value spent
// as tender on a successful order). REFUND is still added by the slice that
// implements it.
//
// R1 / S5a adds REDEMPTION_REVERSAL: value restored to the card because the
// order it paid for was rejected or cancelled (positive; S5b writes it).
export type GiftCardTransactionType =
  | "ISSUANCE"
  | "ADJUSTMENT"
  | "REDEMPTION"
  | "REDEMPTION_REVERSAL";

// A gift card as it appears on the HQ surface. `maskedCode` is the only
// code representation in a normal read (e.g. "•••• •••• •••• 4821");
// `last4` is provided for compact display. The full code and the codeHash
// are never present.
export interface AdminGiftCard {
  id: string;
  maskedCode: string;
  last4: string;
  status: GiftCardStatus;
  originalValueMinorUnits: number;
  balanceMinorUnits: number;
  currency: string;
  createdAt: string;
}

// One row of the immutable gift-card transaction ledger, projected for HQ.
// `amountMinorUnits` is signed; `balanceAfterMinorUnits` is the card
// balance immediately after the entry. `actorLabel` is the HQ operator's
// name/email (present for ISSUANCE and ADJUSTMENT, null for a customer
// REDEMPTION); `reason` is the operator's required text for an ADJUSTMENT
// (null for ISSUANCE / REDEMPTION). `orderNumber` is the human order
// reference for a Milestone 7G REDEMPTION (null otherwise).
export interface AdminGiftCardTransaction {
  id: string;
  type: GiftCardTransactionType;
  amountMinorUnits: number;
  balanceAfterMinorUnits: number;
  reason: string | null;
  actorLabel: string | null;
  orderNumber: string | null;
  createdAt: string;
}

// POST /api/v1/admin/gift-cards/search — the code (or id) is submitted in
// the BODY, never the URL. Exact match only: no search-by-last-4 in V1.
// Exactly one of `code` / `giftCardId` should be provided.
export interface GiftCardSearchRequest {
  code?: string;
  giftCardId?: string;
}

export interface AdminGiftCardSearchResponse {
  giftCards: AdminGiftCard[];
}

// GET /api/v1/admin/gift-cards/:giftCardId
export interface AdminGiftCardDetail {
  giftCard: AdminGiftCard;
  transactions: AdminGiftCardTransaction[];
}

// POST /api/v1/admin/gift-cards — issue a gift card for a legitimate HQ
// administrative reason. `originalValueMinorUnits` is a whole integer,
// 1..GIFT_CARD_MAX_VALUE_MINOR_UNITS. `currency` is optional and must be
// "USD" in V1.
export interface IssueGiftCardRequest {
  originalValueMinorUnits: number;
  currency?: string;
}

// The ONLY response that carries the full plaintext gift-card code. It is
// shown once and is never retrievable again through any read.
export interface IssueGiftCardResponse {
  giftCard: AdminGiftCard;
  code: string;
}

// POST /api/v1/admin/gift-cards/:giftCardId/{deactivate,reactivate}
// `reason` is optional context recorded on the audit event.
export interface GiftCardStatusChangeRequest {
  reason?: string;
}

// POST /api/v1/admin/gift-cards/:giftCardId/corrections — an authorized
// manual balance correction. `deltaMinorUnits` is a non-zero whole integer
// (positive to add, negative to deduct). `reason` is required, trimmed,
// non-empty. `operationKey` is a caller-supplied idempotency key
// (8-200 chars) — retrying the same key never applies the correction twice.
// The resulting balance may never fall below 0 or exceed
// GIFT_CARD_MAX_VALUE_MINOR_UNITS. A correction is permitted on an INACTIVE
// card (an accounting fix is not blocked by status).
export interface AdjustGiftCardBalanceRequest {
  deltaMinorUnits: number;
  reason: string;
  operationKey: string;
}

// GET/PUT /api/v1/admin/gift-cards/configuration (`giftcards.configure`,
// CORPORATE-only). The company-wide gift-card purchasing configuration,
// persisted for the FUTURE customer-purchasing slice — nothing in 7F
// consumes it. `presetAmountsMinorUnits` are ascending, de-duplicated
// whole integers, each 1..GIFT_CARD_MAX_VALUE_MINOR_UNITS (1-12 entries).
export interface GiftCardConfiguration {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
}

export interface UpdateGiftCardConfigurationRequest {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
}

// --- Milestone 7H: Customer Digital Gift Card Purchase & Balance Lookup ---
// Public customer surface. Purchase (POST, OptionalCustomerAuthGuard — guests
// allowed) and balance lookup (POST, no auth). The plaintext gift-card code
// is only ever sent in a request body and only ever returned in the
// immediate purchase response or an idempotent replay within the 7-day
// recovery window — never in a URL, redirect, log, audit, or the balance
// response.

// Fixed custom-amount bounds for a customer purchase (7H — not
// HQ-configurable in V1). A preset may exceed the custom max as long as it
// is <= GIFT_CARD_MAX_VALUE_MINOR_UNITS.
export const GIFT_CARD_CUSTOM_MIN_MINOR_UNITS = 500; // $5.00
export const GIFT_CARD_CUSTOM_MAX_MINOR_UNITS = 50_000; // $500.00

// GET /api/v1/gift-cards/purchase-options (public). What the purchase page
// needs and nothing else.
export interface GiftCardPurchaseOptions {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
  customAmountMinMinorUnits: number;
  customAmountMaxMinorUnits: number;
  currency: string;
}

// The customer purchase is a bounded TWO-STEP protocol so that a
// server-generated recovery credential can reach a guest buyer BEFORE any
// charge (step 1), which is what makes a lost step-2 response recoverable.
// There is ONE persisted aggregate (GiftCardPurchase, status PENDING after
// step 1). Step 1 does not charge and does not issue.

// STEP 1 — POST /api/v1/gift-cards/purchase-intents
// ESP-03 PR 6 — the payment key is generated by the server; every call
// establishes a NEW purchase (nothing is charged until step 2), identified by
// the returned `purchaseId`. A request that sends `idempotencyKey` is
// refused (400 CLIENT_PAYMENT_KEY_NOT_ACCEPTED). `amountMinorUnits` must match an HQ
// preset, or be within [GIFT_CARD_CUSTOM_MIN, GIFT_CARD_CUSTOM_MAX] when
// custom amounts are enabled (validated against the CURRENT configuration —
// step 1 only). `purchaserEmail` is the BUYER's own contact (support /
// future receipt) — NOT a recipient-delivery field.
export interface CreateGiftCardPurchaseIntentRequest {
  amountMinorUnits: number;
  purchaserEmail: string;
  purchaserName?: string | null;
}

export type GiftCardPurchaseStatus =
  | "PENDING"
  | "ISSUED"
  | "RECONCILIATION_REQUIRED";

// Step-1 response. `recoveryCredential` is the one-time, server-generated
// 256-bit secret a GUEST must retain (in memory only) and send back on
// step 2 / recovery — it is returned ONLY here and ONLY when the purchase is
// first established for a guest. `customerOwned` is true when the caller is
// authenticated and owns this purchase (no credential needed then).
export interface GiftCardPurchaseIntentResponse {
  purchaseId: string;
  status: GiftCardPurchaseStatus;
  amountMinorUnits: number;
  currency: string;
  customerOwned: boolean;
  recoveryCredential: string | null;
}

// STEP 2 — POST /api/v1/gift-cards/purchase
// Requires an established intent: its `purchaseId` from step 1 (ESP-03
// PR 6; never a client payment key). It charges + issues on
// the first call and replays the confirmation (with the full code, if
// authorised and in-window) on later calls. `recoveryCredential` is REQUIRED
// for a guest purchase (both the charging call and every recovery replay);
// it is ignored for a signed-in owner. Step 2 never changes the amount,
// contact, or ownership established by step 1.
export interface PurchaseGiftCardRequest {
  purchaseId: string;
  recoveryCredential?: string | null;
}

// The purchase confirmation. `code` (the full plaintext, grouped display
// form) is present ONLY on the initial successful issuance and on an
// authorized idempotent replay before `codeRetrievableUntil`. After that it
// is null and `codeRetrievable` is false — the card still exists and its
// balance can be checked with the code if the buyer saved it.
export interface PurchaseGiftCardResponse {
  purchaseId: string;
  status: GiftCardPurchaseStatus;
  amountMinorUnits: number;
  currency: string;
  maskedCode: string;
  last4: string;
  code: string | null;
  codeRetrievable: boolean;
  codeRetrievableUntil: string | null;
}

// POST /api/v1/gift-cards/balance (public). The code is in the BODY only.
export interface GiftCardBalanceRequest {
  code: string;
}

export type GiftCardPublicStatus = "active" | "inactive" | "depleted";

// A malformed code and an unknown code return the SAME shape ({ found:
// false }) — no enumeration signal. On a hit, only masked identity + the
// balance/status — never codeHash, the full code, the internal id, the
// original value, any ledger, or any purchase/customer/HQ information.
export interface GiftCardBalanceResponse {
  found: boolean;
  maskedCode?: string;
  last4?: string;
  balanceMinorUnits?: number;
  currency?: string;
  status?: GiftCardPublicStatus;
}

// --- Milestone 8A: HQ CRM foundation --------------------------------
// The HQ/Admin read-only view OVER the authoritative customer information
// that already lives in the platform (Milestone 4 identity/profile/prefs +
// Milestone 7 loyalty/gift-cards + orders). Nothing here is a new customer
// system: every field is projected from an existing domain service and no
// business data is copied into CRM-specific storage. `customers.view` gates
// the whole surface; `customers.notes.manage` gates adding a note. Both are
// CORPORATE-only. All endpoints are under /api/v1/admin/customers.

// One row of the Admin customer directory / the header of the detail page.
// Email verification is a boolean derived from the Customer's
// emailVerifiedAt — the timestamp itself is never exposed.
export interface AdminCustomerSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  status: CustomerAccountStatus;
  emailVerified: boolean;
  marketingEmailOptIn: boolean;
  createdAt: string;
}

// GET /api/v1/admin/customers?q=&cursor= — cursor-paginated, createdAt
// descending. `nextCursor` is null on the last page; pass it back as
// `cursor` for the next page. `q` (optional) matches a case-insensitive
// email OR displayName substring, or an exact customer id.
export interface AdminCustomerListResponse {
  customers: AdminCustomerSummary[];
  nextCursor: string | null;
}

// A gift card this customer BOUGHT while signed in — masked identity only.
export interface AdminCustomerGiftCardPurchase {
  purchaseId: string;
  status: GiftCardPurchaseStatus;
  amountMinorUnits: number;
  currency: string;
  maskedCode: string | null;
  last4: string | null;
  createdAt: string;
}

// A gift card redeemed as tender on one of this customer's orders — the
// immutable OrderGiftCardRedemption snapshot, masked.
export interface AdminCustomerGiftCardRedemption {
  orderId: string;
  orderNumber: string;
  last4: string;
  amountMinorUnits: number;
  currency: string;
  createdAt: string;
}

export interface AdminCustomerGiftCardSummary {
  purchases: AdminCustomerGiftCardPurchase[];
  redemptions: AdminCustomerGiftCardRedemption[];
}

// One entry of the customer's HQ activity timeline — projected from the
// polymorphic InternalAuditEvent rows whose targetType is 'customer' (Bean
// adjustments, CRM notes). `summary` is a rendered human sentence; the raw
// action string / target ids are never exposed.
export interface AdminCustomerActivityItem {
  id: string;
  summary: string;
  reason: string | null;
  actorLabel: string | null;
  createdAt: string;
}

// One internal CRM note. Append-only in 8A — there is no edit or delete.
export interface CustomerNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/customers/:customerId/notes
export interface CreateCustomerNoteRequest {
  body: string;
}

export const CUSTOMER_NOTE_MAX_LENGTH = 2000;

// GET /api/v1/admin/customers/:customerId — the aggregated CRM view. Every
// section is a projection of an existing authoritative source; an absent
// section (no orders, no loyalty account, …) is an empty value, not an
// error.
export interface AdminCustomerDetail {
  customer: AdminCustomerSummary;
  orders: {
    count: number;
    recent: CustomerOrderSummary[];
  };
  mochaBeans: {
    balance: number;
    recentActivity: AdminMochaBeanLedgerEntry[];
  };
  affordableRewards: CustomerLoyaltyReward[];
  giftCards: AdminCustomerGiftCardSummary;
  preferredLocations: LocationSummary[];
  communicationPreferences: CustomerCommunicationPreferences;
  notes: CustomerNote[];
  activity: AdminCustomerActivityItem[];
}

// --- Milestone 8B: Careers / Job Openings ---------------------------
// HQ manages job openings (Admin → Careers); the public site lists and
// shows PUBLISHED ones (Careers → Job Openings → detail). Applicant
// submission and applicant management are Milestone 8C — NOT here.

export type JobOpeningStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export type JobEmploymentType =
  | "FULL_TIME"
  | "PART_TIME"
  | "TEMPORARY"
  | "SEASONAL";

// A job opening's location. `null` locationId means a corporate / HQ role.
export interface JobOpeningLocationRef {
  id: string;
  name: string;
}

// The full Admin view of a job opening (all statuses).
export interface AdminJobOpening {
  id: string;
  title: string;
  employmentType: JobEmploymentType;
  location: JobOpeningLocationRef | null;
  summary: string;
  description: string;
  responsibilities: string;
  qualifications: string;
  status: JobOpeningStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /api/v1/admin/careers/jobs?status= (careers.view)
export interface AdminJobOpeningsResponse {
  jobs: AdminJobOpening[];
}

// GET /api/v1/admin/careers/jobs/options (careers.view) — form inputs.
export interface AdminJobOpeningOptions {
  locations: JobOpeningLocationRef[];
  employmentTypes: JobEmploymentType[];
}

// POST /api/v1/admin/careers/jobs (careers.manage). Creates a DRAFT.
// `locationId` null / omitted => a corporate / HQ role.
export interface CreateJobOpeningRequest {
  title: string;
  employmentType: JobEmploymentType;
  locationId?: string | null;
  summary: string;
  description: string;
  responsibilities: string;
  qualifications: string;
}

// PATCH /api/v1/admin/careers/jobs/:jobId (careers.manage). Every field is
// optional; `status` / `publishedAt` are NOT accepted here — status changes
// only through the explicit publish / unpublish / archive actions.
export interface UpdateJobOpeningRequest {
  title?: string;
  employmentType?: JobEmploymentType;
  locationId?: string | null;
  summary?: string;
  description?: string;
  responsibilities?: string;
  qualifications?: string;
}

// Reasonable length limits (consistent with promotions / CRM conventions).
export const JOB_OPENING_TITLE_MAX_LENGTH = 160;
export const JOB_OPENING_SUMMARY_MAX_LENGTH = 400;
export const JOB_OPENING_LONG_TEXT_MAX_LENGTH = 8000;

// The public projection — only ever built for a publicly-visible job
// (PUBLISHED and either corporate or an active location).
export interface PublicJobOpeningSummary {
  id: string;
  title: string;
  employmentType: JobEmploymentType;
  locationName: string | null; // null => "Corporate"
  summary: string;
  publishedAt: string | null;
}

export interface PublicJobOpeningsResponse {
  jobs: PublicJobOpeningSummary[];
}

export interface PublicJobOpeningDetail extends PublicJobOpeningSummary {
  description: string;
  responsibilities: string;
  qualifications: string;
}

// --- Milestone 8C: Applicants -------------------------------------
// A visitor applies to a currently-visible published job (no account).
// HQ views applicants, moves an application through a tiny status set, and
// adds internal notes. NOT a full ATS: no interviews / offers / onboarding
// / applicant login / email automation / file upload.

export type JobApplicationStatus =
  | "NEW"
  | "REVIEWING"
  | "CONTACTED"
  | "HIRED"
  | "REJECTED";

export const JOB_APPLICATION_STATUSES: readonly JobApplicationStatus[] = [
  "NEW",
  "REVIEWING",
  "CONTACTED",
  "HIRED",
  "REJECTED",
];

// Bounded lengths, consistent with promotions / CRM conventions.
export const JOB_APPLICATION_NAME_MAX_LENGTH = 120;
export const JOB_APPLICATION_SHORT_MAX_LENGTH = 200;
export const JOB_APPLICATION_MESSAGE_MAX_LENGTH = 4000;
export const JOB_APPLICATION_URL_MAX_LENGTH = 2048;
export const JOB_APPLICATION_NOTE_MAX_LENGTH = 2000;

// POST /api/v1/careers/jobs/:jobId/applications (public, no auth). Returns
// ONLY { ok: true } — never an id or the stored record.
export interface SubmitJobApplicationRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string; // "City, State"
  workAuthorized: boolean;
  availability: string;
  message: string;
  // "Resume / LinkedIn / Portfolio Link (optional)" — one http(s) URL.
  resumeUrl?: string | null;
}

export interface SubmitJobApplicationResponse {
  ok: true;
}

// One row of the Admin applicants list.
export interface AdminJobApplicationSummary {
  id: string;
  applicantName: string;
  email: string;
  jobOpeningId: string;
  jobTitleSnapshot: string;
  status: JobApplicationStatus;
  createdAt: string;
}

// GET /api/v1/admin/careers/applications?status=&jobOpeningId=&cursor=
// (applicants.view) — cursor-paginated, newest first.
export interface AdminJobApplicationsResponse {
  applications: AdminJobApplicationSummary[];
  nextCursor: string | null;
}

// GET /api/v1/admin/careers/applications/:id (applicants.view).
export interface AdminJobApplicationDetail {
  id: string;
  status: JobApplicationStatus;
  jobOpeningId: string;
  jobTitleSnapshot: string;
  // The job's current status, so HQ can tell if the opening is still live.
  jobStatus: JobOpeningStatus | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  workAuthorized: boolean;
  availability: string;
  message: string;
  resumeUrl: string | null;
  createdAt: string;
  updatedAt: string;
  notes: JobApplicationNote[];
  activity: AdminJobApplicationActivityItem[];
}

// POST /api/v1/admin/careers/applications/:id/status (applicants.manage).
export interface UpdateJobApplicationStatusRequest {
  status: JobApplicationStatus;
}

// One internal applicant note. Append-only in 8C.
export interface JobApplicationNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/careers/applications/:id/notes (applicants.manage).
export interface CreateJobApplicationNoteRequest {
  body: string;
}

// One entry of the applicant activity timeline (from InternalAuditEvent,
// targetType 'job_application'). No answer data / PII.
export interface AdminJobApplicationActivityItem {
  id: string;
  summary: string;
  actorLabel: string | null;
  createdAt: string;
}

// --- Milestone 8D, Franchising inquiries -----------------------------
// A prospective franchisee's contact + interest record. One flat model, no
// separate "prospect" identity — mirrors the 8C Applicants shape. No file
// uploads, no financial documents; investmentRange / timeframe are free
// text (no invented $ or time buckets).

export type FranchiseInquiryStatus =
  | "NEW"
  | "REVIEWING"
  | "CONTACTED"
  | "QUALIFIED"
  | "CLOSED";

export const FRANCHISE_INQUIRY_STATUSES: readonly FranchiseInquiryStatus[] = [
  "NEW",
  "REVIEWING",
  "CONTACTED",
  "QUALIFIED",
  "CLOSED",
];

export const FRANCHISE_INQUIRY_NAME_MAX_LENGTH = 120;
export const FRANCHISE_INQUIRY_SHORT_MAX_LENGTH = 200;
export const FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH = 4000;
export const FRANCHISE_INQUIRY_NOTE_MAX_LENGTH = 2000;

// POST /api/v1/franchising/inquiries — no auth. Response is only
// { ok: true }; no id, no submitted data.
export interface SubmitFranchiseInquiryRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  preferredMarket: string;
  investmentRange?: string | null;
  timeframe?: string | null;
  businessExperience?: string | null;
  message?: string | null;
  consentAcknowledged: boolean;
}

export interface SubmitFranchiseInquiryResponse {
  ok: true;
}

// One row of the Admin franchising inquiries list.
export interface AdminFranchiseInquirySummary {
  id: string;
  prospectName: string;
  email: string;
  preferredMarket: string;
  status: FranchiseInquiryStatus;
  createdAt: string;
}

// GET /api/v1/admin/franchising/inquiries?status=&cursor= (franchising.view)
// — cursor-paginated, newest first.
export interface AdminFranchiseInquiriesResponse {
  inquiries: AdminFranchiseInquirySummary[];
  nextCursor: string | null;
}

// GET /api/v1/admin/franchising/inquiries/:id (franchising.view).
export interface AdminFranchiseInquiryDetail {
  id: string;
  status: FranchiseInquiryStatus;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  preferredMarket: string;
  investmentRange: string | null;
  timeframe: string | null;
  businessExperience: string | null;
  message: string | null;
  consentAcknowledged: boolean;
  createdAt: string;
  updatedAt: string;
  notes: FranchiseInquiryNote[];
  activity: AdminFranchiseInquiryActivityItem[];
}

// POST /api/v1/admin/franchising/inquiries/:id/status (franchising.manage).
export interface UpdateFranchiseInquiryStatusRequest {
  status: FranchiseInquiryStatus;
}

// One internal inquiry note. Append-only in 8D.
export interface FranchiseInquiryNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/franchising/inquiries/:id/notes (franchising.manage).
export interface CreateFranchiseInquiryNoteRequest {
  body: string;
}

// One entry of the inquiry activity timeline (from InternalAuditEvent,
// targetType 'franchise_inquiry'). No answer data / PII.
export interface AdminFranchiseInquiryActivityItem {
  id: string;
  summary: string;
  actorLabel: string | null;
  createdAt: string;
}

// --- Milestone S0D-2C-3, tenant-owned notification recipient routing ----
// Which address receives a Careers/Franchising business notification is
// per-tenant configuration (NotificationRecipient), resolved by the worker
// from the triggering OutboxEvent's own tenantId — never from a global env
// var, never from another tenant's row. This is the closed set of purposes
// that configuration can exist for today; a new purpose is an application
// change (add a union member + a worker case), never a migration.
export const NOTIFICATION_RECIPIENT_PURPOSES = [
  "careers.application.received",
  "franchising.inquiry.received",
] as const;

export type NotificationRecipientPurpose =
  (typeof NOTIFICATION_RECIPIENT_PURPOSES)[number];

export interface NotificationRecipient {
  purpose: NotificationRecipientPurpose;
  email: string;
  updatedAt: string;
}

// GET /api/v1/admin/notifications/recipients (notifications.routing.view,
// CORPORATE-only). Returns every purpose, including ones with no
// configured recipient yet (email: null) — missing configuration is a
// legitimate state the admin UI/caller must be able to see, not an error.
export interface AdminNotificationRecipientsResponse {
  recipients: { purpose: NotificationRecipientPurpose; email: string | null; updatedAt: string | null }[];
}

// PUT /api/v1/admin/notifications/recipients/:purpose
// (notifications.routing.manage, CORPORATE-only). Upserts the current
// tenant's recipient for that purpose.
export interface UpdateNotificationRecipientRequest {
  email: string;
}

// --- Milestone 8E, CMS foundation --------------------------------------
// Structured content management for a small, code-defined set of public
// page keys — NOT a page builder. Layout/design stay owned by the Next.js
// pages/components; the CMS only supplies structured field values. Each
// page key has ONE fixed content shape (defined in the registry, mirrored
// here per key) — no arbitrary fields, no HTML, no dynamic sections.
//
// A CmsPage row always carries a draft; `publishedContent` is a separate
// snapshot copied over only by an explicit publish action. Before the
// first publish, status is DRAFT and there is no public content. After the
// first publish, status is PUBLISHED for good (no unpublish) — further
// draft edits never affect the live `publishedContent` until the next
// publish. `hasUnpublishedChanges` is derived (true whenever draftContent
// differs from publishedContent, or nothing has been published yet).

export type CmsPageStatus = "DRAFT" | "PUBLISHED";

export const CMS_PAGE_KEYS = ["franchising", "home"] as const;
export type CmsPageKey = (typeof CMS_PAGE_KEYS)[number];

export const CMS_TEXT_MAX_LENGTH = 200;
export const CMS_BODY_MAX_LENGTH = 2000;
export const CMS_BUTTON_LABEL_MAX_LENGTH = 60;
export const CMS_SEO_TITLE_MAX_LENGTH = 70;
export const CMS_SEO_DESCRIPTION_MAX_LENGTH = 200;
export const CMS_PROCESS_STEPS_MIN = 1;
export const CMS_PROCESS_STEPS_MAX = 6;
// Milestone 8F — Home's Featured Products strip.
export const CMS_FEATURED_PRODUCTS_MAX = 8;

export interface CmsSeoFields {
  pageTitle?: string | null;
  metaDescription?: string | null;
}

// The ONE 8E content shape (page key "franchising"). Every field is plain
// text — no HTML, no arbitrary URLs (the CTA's destination stays
// code-owned by the page component).
export interface FranchisingPageContent {
  intro: { heading: string; body: string };
  opportunity: { heading: string; body: string };
  process: {
    heading: string;
    // 1..6 steps (CMS_PROCESS_STEPS_MIN..CMS_PROCESS_STEPS_MAX).
    steps: { title: string; body: string }[];
  };
  cta: { heading: string; body: string; buttonLabel: string };
  seo: CmsSeoFields;
}

// Milestone 8F — the Home page content shape (page key "home"). The hero's
// CTA destination stays code-owned (no URL field, same rule as
// Franchising's CTA). `backgroundImageId` references a MediaAsset by id —
// resolved to a URL server-side, never stored as a URL here.
// `featuredProducts.productIds` references authoritative catalog Product
// ids ONLY — no name / price / description / availability is ever
// duplicated into CMS content.
export interface HomePageContent {
  hero: {
    headline: string;
    supportingText: string;
    buttonLabel: string;
    backgroundImageId: string | null;
  };
  featuredProducts: {
    heading: string;
    // Ordered, 0..CMS_FEATURED_PRODUCTS_MAX, no duplicates.
    productIds: string[];
  };
  seo: CmsSeoFields;
}

// The content shape varies by page key — this union is narrowed by the
// caller using the known `key`.
export type CmsPageContent = FranchisingPageContent | HomePageContent;

// GET /api/v1/content/:pageKey — no auth. Published content only; 404 for
// an unknown key, a key with no row, or a key never published. Never
// exposes draft content.
export interface PublicCmsPageContentResponse {
  content: CmsPageContent;
}

// GET /api/v1/content/franchising specifically.
export interface PublicFranchisingPageContentResponse {
  content: FranchisingPageContent;
}

// GET /api/v1/content/home specifically. `hero.backgroundImageUrl` and each
// featured product are resolved server-side — the public response never
// carries a bare `backgroundImageId` or product id needing a second fetch.
export interface PublicHomePageContent {
  hero: {
    headline: string;
    supportingText: string;
    buttonLabel: string;
    backgroundImageUrl: string | null;
  };
  featuredProducts: {
    heading: string;
    products: ProductSummary[];
  };
  seo: CmsSeoFields;
}

export interface PublicHomePageContentResponse {
  content: PublicHomePageContent;
}

// One row of GET /api/v1/admin/content (cms.view).
export interface AdminCmsPageSummary {
  key: CmsPageKey;
  title: string;
  status: CmsPageStatus;
  publishedAt: string | null;
  updatedAt: string | null;
  hasUnpublishedChanges: boolean;
}

export interface AdminCmsPagesResponse {
  pages: AdminCmsPageSummary[];
}

// GET /api/v1/admin/content/:pageKey (cms.view). When no row exists yet,
// this is synthesized from the registry default — DRAFT,
// publishedContent null, hasUnpublishedChanges true — WITHOUT writing to
// the database.
export interface AdminCmsPageDetail {
  key: CmsPageKey;
  title: string;
  status: CmsPageStatus;
  draftContent: CmsPageContent;
  publishedContent: CmsPageContent | null;
  publishedAt: string | null;
  updatedAt: string | null;
  hasUnpublishedChanges: boolean;
}

// PATCH /api/v1/admin/content/:pageKey (cms.manage) — save draft. The full
// content shape is required (not a partial patch); the row is
// created/upserted on first save.
export interface UpdateCmsPageContentRequest {
  content: CmsPageContent;
}

// POST /api/v1/admin/content/:pageKey/publish (cms.manage). No body.

// --- Milestone 8F, Media Library ---------------------------------------
// A minimal, HQ-only image library backing CMS content (currently Home's
// hero background). No folders, tags, cropping, or transformations — a
// flat, append-mostly list of uploaded images. Deletion is soft
// (`isActive`) and the API blocks deactivating an asset that is still
// referenced by known CMS content (see 409 behavior on the deactivate
// route) — the S3 object itself is never removed in 8F.

export const MEDIA_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type MediaContentType = (typeof MEDIA_ALLOWED_CONTENT_TYPES)[number];

export const MEDIA_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// One row of GET /api/v1/admin/media (media.view). `publicUrl` is resolved
// server-side from the configured MediaStorage — the object key itself is
// not exposed. title/altText (Milestone 8I) are optional, admin-editable
// metadata — never derived from the file itself.
export interface AdminMediaAsset {
  id: string;
  fileName: string;
  title: string | null;
  altText: string | null;
  contentType: string;
  fileSizeBytes: number;
  publicUrl: string;
  // Always true in GET /admin/media (list) results — that endpoint only
  // ever returns active assets. GET /admin/media/:id (Milestone 8I) is the
  // only place this can be false, since the detail screen must be able to
  // show an already-archived asset's state.
  isActive: boolean;
  uploadedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMediaAssetsResponse {
  assets: AdminMediaAsset[];
  nextCursor: string | null;
}

// POST /api/v1/admin/media (media.manage) — multipart/form-data, field
// "file". No JSON request type; the response is the created asset.
export interface UploadMediaAssetResponse {
  asset: AdminMediaAsset;
}

// GET /api/v1/admin/media/:mediaAssetId (media.view, Milestone 8I).
export interface GetMediaAssetResponse {
  asset: AdminMediaAsset;
}

// PATCH /api/v1/admin/media/:mediaAssetId (media.manage, Milestone 8I).
// title/altText ONLY — file/object metadata (fileName, contentType,
// fileSizeBytes, objectKey), uploader, active state, and ids are never
// editable through this route. Omitted fields are left unchanged; an
// explicit null clears the field.
export interface UpdateMediaAssetMetadataRequest {
  title?: string | null;
  altText?: string | null;
}

export interface UpdateMediaAssetMetadataResponse {
  asset: AdminMediaAsset;
}

// POST /api/v1/admin/media/:mediaAssetId/deactivate (media.manage). 409
// (not 200) when the asset is still referenced by known CMS content
// (draft or published) — the deactivation is refused, not applied.
export interface DeactivateMediaAssetResponse {
  asset: AdminMediaAsset;
}

// --- Milestone 8G, Marketing Campaigns ---------------------------------
// A thin HQ "Campaign Management" layer that ORGANIZES existing systems —
// Promotions & Coupons (7E), Bonus Mocha Bean Promotions (7D), the Product
// catalog and the Media Library — rather than reimplementing any of them.
// A campaign optionally references ONE Promotion and/or ONE
// LoyaltyBonusPromotion as independent optional benefits; it performs NO
// discount or Mocha Beans calculation itself. Its own DRAFT -> ACTIVE ->
// ENDED lifecycle (ENDED is terminal, mirroring JobOpening's terminal
// ARCHIVED) is purely organizational and never mutates a linked record.
// There is no campaign-to-order attribution in 8G — zero checkout/runtime
// behavior.

export type CampaignStatus = "DRAFT" | "ACTIVE" | "ENDED";

export const CAMPAIGN_NAME_MAX_LENGTH = 120;
export const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 1000;
export const CAMPAIGN_FEATURED_PRODUCTS_MAX = 8;

// A featured product as shown on a campaign — id/name/category only, read
// live from the authoritative catalog at request time. Price, availability
// and every other product attribute are NEVER duplicated onto a campaign.
export interface AdminCampaignProductRef {
  id: string;
  name: string;
  category: { id: string; name: string };
  isActive: boolean;
  displayOrder: number;
}

// A linked Promotion / LoyaltyBonusPromotion — id/name/active-state only.
// The linked system remains the sole source of truth for everything else
// (discount rules, bonus rules, eligibility, redemption).
export interface AdminCampaignPromotionRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface AdminCampaignLoyaltyBonusPromotionRef {
  id: string;
  name: string;
  isActive: boolean;
}

// Milestone 8J — a campaign's derived approval state, computed server-side
// on every read (never persisted on Campaign itself). An APPROVED request
// that has gone stale (the campaign was edited after it was decided —
// campaign.updatedAt > that request's decidedAt) is reported as "NONE",
// not "APPROVED": from the UI/activation-gate's perspective a stale
// approval simply isn't a valid one anymore.
export type CampaignApprovalStatus = "NONE" | "PENDING" | "APPROVED" | "REJECTED";

// One campaign, used for both the list and the detail view (GET
// /api/v1/admin/marketing/campaigns and .../:campaignId, marketing.view).
export interface AdminCampaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  // A MediaAsset id, resolved to a preview by the Admin media picker —
  // never a URL stored here (mirrors CmsPage's hero.backgroundImageId).
  mediaAssetId: string | null;
  promotion: AdminCampaignPromotionRef | null;
  loyaltyBonusPromotion: AdminCampaignLoyaltyBonusPromotionRef | null;
  // Ordered by displayOrder ascending.
  featuredProducts: AdminCampaignProductRef[];
  createdAt: string;
  updatedAt: string;
  // Milestone 8J — the latest ApprovalRequest for this campaign's
  // activation, collapsed to the four states above. `latestApprovalRequestId`
  // is null exactly when approvalStatus is "NONE".
  approvalStatus: CampaignApprovalStatus;
  latestApprovalRequestId: string | null;
}

export interface AdminCampaignsResponse {
  campaigns: AdminCampaign[];
  nextCursor: string | null;
}

// GET /api/v1/admin/marketing/campaigns/options (marketing.view) — the
// bounded reference lists the campaign editor needs to build its selects.
// Self-contained (queried directly, like Promotion's own /options), so
// `marketing.view` alone is enough — a Marketing user does not also need
// `catalog.view` / `promotions.configure` / `loyalty.configure` just to see
// what exists to link.
export interface AdminCampaignOptions {
  products: { id: string; name: string; category: { id: string; name: string }; isActive: boolean }[];
  promotions: AdminCampaignPromotionRef[];
  loyaltyBonusPromotions: AdminCampaignLoyaltyBonusPromotionRef[];
}

// POST /api/v1/admin/marketing/campaigns (marketing.manage). A new campaign
// always starts DRAFT. `featuredProductIds` is the ordered list (index =
// displayOrder); duplicates are rejected.
export interface CreateCampaignRequest {
  name: string;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  mediaAssetId?: string | null;
  promotionId?: string | null;
  loyaltyBonusPromotionId?: string | null;
  featuredProductIds?: string[];
}

// PATCH /api/v1/admin/marketing/campaigns/:campaignId (marketing.manage).
// Never changes status — see UpdateCampaignStatusRequest.
export interface UpdateCampaignRequest {
  name?: string;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  mediaAssetId?: string | null;
  promotionId?: string | null;
  loyaltyBonusPromotionId?: string | null;
  featuredProductIds?: string[];
}

// POST /api/v1/admin/marketing/campaigns/:campaignId/status
// (marketing.manage). The only two allowed moves are DRAFT -> ACTIVE and
// ACTIVE -> ENDED; ENDED is terminal. Activating revalidates every linked
// reference (media, featured products, promotion, bonus promotion) and
// returns 409 without mutating anything if one is not currently usable.
export interface UpdateCampaignStatusRequest {
  status: CampaignStatus;
}

// POST /api/v1/admin/marketing/campaigns/:campaignId/request-approval
// (marketing.manage, Milestone 8J). Campaign must be DRAFT. Idempotent: a
// second call while a request is already PENDING reuses that same request
// rather than creating a duplicate. Returns the bare campaign (approvalStatus
// now "PENDING") — the same unwrapped shape create/update/status already
// return; the full ApprovalRequest detail lives on the dedicated
// /admin/approvals screens instead.

// --- Milestone 8J, Approvals -------------------------------------------
// A generic request/decide primitive (see ApprovalRequest in the Prisma
// schema for the full rationale). Only one workflow is wired to it in this
// slice — see APPROVAL_TARGET_TYPE_CAMPAIGN / APPROVAL_ACTION below.

export const APPROVAL_TARGET_TYPE_CAMPAIGN = "Campaign";
export const APPROVAL_ACTION_CAMPAIGN_ACTIVATE = "marketing.campaign_activate";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

// One row of GET /api/v1/admin/approvals (approvals.view). `targetLabel` is
// a short human-readable description of the target — for this slice's only
// target type (Campaign) that's the campaign's own name. There is
// deliberately no "forbidden, degraded view" case: for a Campaign-targeted
// request the service ALSO requires marketing.view (see
// ApprovalsAdminService), so a caller either sees the full row or gets a
// 403 — never a row with this blanked out.
export interface AdminApprovalRequest {
  id: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  action: string;
  status: ApprovalStatus;
  requestedByLabel: string;
  createdAt: string;
  decidedByLabel: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
}

export interface AdminApprovalRequestsResponse {
  approvalRequests: AdminApprovalRequest[];
  nextCursor: string | null;
}

export interface GetApprovalRequestResponse {
  approvalRequest: AdminApprovalRequest;
}

// --- Milestone 9A, HQ Reporting: Digital Sales & Orders -----------------
// Served only from `GET /api/v1/admin/reports/orders-overview`
// (InternalAuthGuard + PermissionGuard + `reports.view`, CORPORATE-only).
//
// This is a digital-platform report, not a total-store-sales report — there
// is no KwickPOS integration and no in-store/register order path in this
// codebase, so `Order` rows only ever originate from the digital checkout
// flow. `source` below exists precisely so the UI never has to guess or
// silently imply a broader scope than the data actually has.
//
// `startDate` / `endDate` are business-calendar dates ('YYYY-MM-DD') in the
// platform's single business timezone (America/Detroit, see
// MOCHA_HOUSE_TIME_ZONE) — both ends inclusive. An order is "in range" when
// its `createdAt` instant falls on one of those business calendar days,
// not when its UTC clock date does.
//
// "INTERNAL_OPERATIONS" (Milestone 9C) is a second, unrelated source scope
// for store-operations data (checklist activity) — never sales data. This
// is deliberately kept as a small closed union, not a generalized data
// catalog: each report states its own scope explicitly so the UI never has
// to guess or silently imply a broader meaning than the data actually has.
// "CUSTOMER_PLATFORM" (Milestone 9D) is a third source scope for reports
// that combine Customer account records with digital-platform Order
// records — never POS/in-store customer or order data, and never sales
// data on its own (that's "DIGITAL_PLATFORM_ONLY").
export type AdminReportDataSourceScope =
  | "DIGITAL_PLATFORM_ONLY"
  | "INTERNAL_OPERATIONS"
  | "CUSTOMER_PLATFORM";

export interface AdminReportDataSource {
  scope: AdminReportDataSourceScope;
  // "Digital-platform orders only. In-store/POS transactions are not
  // included." — shown in the UI without a tooltip, never abbreviated to
  // "Total sales" or similar.
  scopeLabel: string;
  // "Live platform data" — every figure is a live PostgreSQL read; there is
  // no import, cache or external system behind it.
  freshnessLabel: string;
}

export interface AdminReportLocationRef {
  id: string;
  name: string;
}

// Money fields stay integer minor units through this contract — formatting
// to dollars is a presentation-layer concern (see apps/web `lib/money.ts`).
export interface AdminOrdersOverviewReport {
  filters: {
    startDate: string; // YYYY-MM-DD, business calendar date, inclusive
    endDate: string; // YYYY-MM-DD, business calendar date, inclusive
    locationId: string | null; // null = every location
  };
  // The filtered location's id/name, or null when the report spans every
  // location ("All locations").
  location: AdminReportLocationRef | null;
  // Every active location, for the report's own location filter control.
  // Included here (rather than requiring a second call to
  // `/admin/locations`, which needs `locations.view`) so `reports.view`
  // alone is sufficient to use this report.
  availableLocations: AdminReportLocationRef[];
  // Every digital-platform order created in the selected period/location
  // that is a commercial order: regardless of its current status EXCEPT
  // REJECTED and CANCELLED, which are never counted here, in
  // digitalSalesMinorUnits or in averageOrderValueMinorUnits (they appear only
  // in statusBreakdown).
  totalOrders: number;
  // Of those, the ones whose current status is COMPLETED.
  completedOrders: number;
  // SUM(subtotal - promotionDiscountMinorUnits - rewardDiscountMinorUnits)
  // over the selected population. Gift card tender is a payment method, not
  // a discount, and is deliberately NOT subtracted. Excludes tax, tips and
  // refunds — none of those are modelled in the current Order schema.
  digitalSalesMinorUnits: number;
  // digitalSalesMinorUnits / totalOrders, rounded to the nearest minor
  // unit; 0 when totalOrders is 0.
  averageOrderValueMinorUnits: number;
  // Count per OrderStatus within the selected period/location (not
  // completed-only). Unlike totalOrders it INCLUDES REJECTED and CANCELLED, so
  // the closed orders stay visible without counting as sales.
  statusBreakdown: Record<OrderStatus, number>;
  source: AdminReportDataSource;
}

// POST /api/v1/admin/approvals/:approvalRequestId/approve (approvals.decide).
export interface ApproveApprovalRequestResponse {
  approvalRequest: AdminApprovalRequest;
}

// POST /api/v1/admin/approvals/:approvalRequestId/reject (approvals.decide).
// `reason` is required (non-empty, trimmed) — validated the same way as
// every other required-reason field in Admin (e.g. loyalty adjustments).
export interface RejectApprovalRequestRequest {
  reason: string;
}

export interface RejectApprovalRequestResponse {
  approvalRequest: AdminApprovalRequest;
}

// --- Milestone 9B, HQ Reporting: Location Performance --------------------
// Served only from `GET /api/v1/admin/reports/location-performance`
// (InternalAuthGuard + PermissionGuard + `reports.view`, CORPORATE-only —
// the same permission as 9A's Digital Sales & Orders report; there is no
// separate `reports.locations.view`).
//
// Compares locations against EACH OTHER for digital-platform ordering —
// `source` below is the exact 9A digital-platform-only disclosure, never a
// total-store/POS figure. `startDate`/`endDate` use the exact 9A
// business-calendar-date semantics (America/Detroit, both ends inclusive).
//
// Inclusion rule: every currently active Location appears, even with zero
// orders in the period (that's meaningful management information, not a
// gap); an INACTIVE location appears only if it has at least one order in
// the selected period (preserves history without resurrecting a closed
// location that has nothing to show for this range).
export interface AdminLocationPerformanceRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
  // Every commercial digital-platform order created at this location in the
  // selected period, regardless of status EXCEPT REJECTED and CANCELLED, which
  // are excluded here and from the sales and average-order figures below.
  totalOrders: number;
  // Of those, the ones whose current status is COMPLETED.
  completedOrders: number;
  // completedOrders / totalOrders * 100, rounded to one decimal place; 0
  // when totalOrders is 0. NOTE: rejected and cancelled orders are excluded
  // from totalOrders, so an order that isn't COMPLETED is still in progress
  // (RECEIVED/ACCEPTED/PREPARING/READY) — this
  // figure is most meaningful for a period that has already ended, and the
  // UI must say so visibly (never only in a tooltip).
  completedPercent: number;
  // SUM(subtotal - promotionDiscountMinorUnits - rewardDiscountMinorUnits)
  // at this location over the selected period — identical definition to
  // AdminOrdersOverviewReport.digitalSalesMinorUnits. Gift card tender is a
  // payment method, not a discount, and is deliberately NOT subtracted.
  digitalSalesMinorUnits: number;
  // digitalSalesMinorUnits / totalOrders, rounded to the nearest minor
  // unit; 0 when totalOrders is 0.
  averageOrderValueMinorUnits: number;
}

// Deliberately no overall summary field — calling
// GET /admin/reports/orders-overview with no locationId already gives the
// combined all-location figure for the same range; duplicating that
// computation here would just be two sources of truth for one number.
export interface AdminLocationPerformanceReport {
  filters: {
    startDate: string; // YYYY-MM-DD, business calendar date, inclusive
    endDate: string; // YYYY-MM-DD, business calendar date, inclusive
  };
  // Sorted locationName ascending, locationId ascending as a tiebreaker.
  // Never sorted by a metric — this is a comparison table, not a ranking.
  locations: AdminLocationPerformanceRow[];
  source: AdminReportDataSource;
}

// --- Milestone 9C, HQ Reporting: Operations Checklist Visibility --------
// Served only from `GET /api/v1/admin/reports/operations-checklists`
// (InternalAuthGuard + PermissionGuard + `reports.view`, CORPORATE-only —
// the same permission as 9A/9B; there is no separate operations-report
// permission). `source.scope` is "INTERNAL_OPERATIONS", never
// "DIGITAL_PLATFORM_ONLY" — this has nothing to do with sales or orders.
//
// This is OPERATIONS VISIBILITY, not compliance scoring. It is NOT proof
// that a checklist was missed, and it is NOT proof a store failed to open
// or close correctly:
//
//   - A ChecklistInstance is created lazily, only when staff actually open
//     a checklist screen for that location on that business day. A
//     location with zero recorded activity in the selected period may
//     simply mean nobody opened the screen that day (holiday, a closed
//     location, or staff completing the physical checklist without ever
//     loading it) — it is NOT evidence the checklist was skipped or the
//     store failed to open/close. The UI MUST say this plainly, not only
//     in a tooltip.
//   - "Current Exceptions" counts ChecklistInstanceItem rows whose
//     `exceptionAt` is currently set. If an exception was logged and later
//     cleared, `exceptionAt` reverts to null and that event is no longer
//     represented here — this field is a live-state count, not a
//     historical log of every exception ever raised. The UI MUST disclose
//     this plainly as well.
//
// `startDate`/`endDate` use `ChecklistInstance.businessDate` directly (a
// stored `@db.Date` value, resolved once at instance creation) — NOT
// `createdAt`, and NOT the Order-report instant-range conversion used by
// 9A/9B. The range is a simple inclusive comparison:
// `businessDate >= startDate AND businessDate <= endDate`.
//
// Opening vs closing is classified by the stable `ChecklistTemplate.key`
// ("opening" / "closing"), never by the template's display name.
//
// Deliberately excluded: any completion percentage, exception rate,
// missed/compliance metric, actor identifiers, employee names, or
// individual completion counts — none of that is either persisted in a
// trustworthy form or in scope for this slice.
export interface AdminOperationsChecklistRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  // Count of opening ChecklistInstance rows in the selected business-date
  // range at this location — an engagement fact ("a device loaded the
  // checklist"), not a compliance fact.
  openingStarted: number;
  // Of those, the ones with `completedAt` set — trusts the persisted
  // ChecklistInstance.completedAt projection maintained by the Operations
  // domain; never recomputed from items here.
  openingCompleted: number;
  // Current-state count only — see the section comment above.
  openingCurrentExceptions: number;
  closingStarted: number;
  closingCompleted: number;
  closingCurrentExceptions: number;
}

export interface AdminOperationsChecklistReport {
  filters: {
    startDate: string; // YYYY-MM-DD, business calendar date, inclusive
    endDate: string; // YYYY-MM-DD, business calendar date, inclusive
  };
  // Sorted locationName ascending, locationId ascending as a tiebreaker.
  // Never sorted by a metric — this is a comparison table, not a ranking.
  locations: AdminOperationsChecklistRow[];
  source: AdminReportDataSource;
}

// --- Milestone 9D, HQ Reporting: Customer Growth & Ordering --------------
// Served only from `GET /api/v1/admin/reports/customer-growth`
// (InternalAuthGuard + PermissionGuard + `reports.view`, CORPORATE-only —
// the same permission as 9A/9B/9C; there is no separate customer-report
// permission). `source.scope` is "CUSTOMER_PLATFORM" — this report
// combines Customer account records with digital-platform Order records,
// never POS/in-store data.
//
// `startDate`/`endDate` are business-calendar dates ('YYYY-MM-DD',
// America/Detroit, both ends inclusive) converted to UTC instant
// boundaries exactly like 9A/9B (`createdAt >= start instant`,
// `createdAt < end-date-next-day instant`) — both `Customer.createdAt` and
// `Order.createdAt` are real timestamp columns, so this uses the same
// instant-range strategy as the Order reports, NOT 9C's `@db.Date`
// direct-range strategy (Customer/Order have no stored calendar-date
// column to compare against).
//
// This is customer-base SIZE and digital-ordering PARTICIPATION during a
// period — deliberately NOT retention, churn, conversion, lifetime value,
// customer scoring, or segmentation. None of those concepts are defined
// here and none are computed.
export interface AdminCustomerGrowthReport {
  filters: {
    startDate: string; // YYYY-MM-DD, business calendar date, inclusive
    endDate: string; // YYYY-MM-DD, business calendar date, inclusive
  };
  // COUNT(Customer) WHERE createdAt < end-date-next-day instant. A
  // cumulative "as of" figure, NOT scoped to the selected period alone —
  // deliberately not called "Total Customers" so it's never mistaken for
  // a period metric.
  registeredCustomersAsOfEndDate: number;
  // COUNT(Customer) WHERE createdAt is within [start instant, end-date-
  // next-day instant) — customers who joined during the selected period.
  newRegisteredCustomers: number;
  // Distinct non-null Order.customerId among digital-platform orders
  // created in the selected period. NOT "active", "retained" or
  // "engaged" customers — just "placed at least one digital order in
  // this period."
  registeredCustomersWithOrders: number;
  // Registered customers with >= 2 digital-platform orders created WITHIN
  // the selected period specifically — never a lifetime or cross-period
  // count. A customer with one order last period and one this period is
  // NOT counted here.
  repeatRegisteredCustomers: number;
  // COUNT(Order) WHERE customerId IS NOT NULL, in the selected period —
  // the direct counterpart to guestOrders; together they sum to every
  // digital-platform order created in the period.
  registeredCustomerOrders: number;
  // COUNT(Order) WHERE customerId IS NULL, in the selected period. Guest
  // orders are legitimate digital-platform orders, never an "unidentified
  // registered customer."
  guestOrders: number;
  source: AdminReportDataSource;
}

// --- R1 / S4c, notification health -------------------------------------
// GET /api/v1/admin/notifications/health (notifications.routing.view,
// CORPORATE-only; strictly the caller's own business). A read-only summary of
// where this business's notifications stand, built from the outbox:
//   waiting         due now, picked up within the delay threshold
//   inProgress      leased by a worker right now
//   scheduledRetry  failed an attempt, waiting out its backoff
//   delayed         due for longer than the delay threshold and still not
//                   picked up (the worker may be stopped or held back)
//   failed          dead-lettered: permanent failure, retries exhausted,
//                   expired, or a crash loop (events an operator closed on
//                   purpose are reported separately and never alert)
//   accepted        the email provider accepted the message (this does NOT
//                   mean it reached the inbox)
// Carries no recipient address, message text, token or provider detail:
// only counts, ages, machine-readable reason codes and the customer-visible
// order number.
export type NotificationHealthStatus = "ok" | "warning" | "critical";
export type NotificationAttentionSeverity = "info" | "warning" | "critical";
export type NotificationHealthItemState =
  | "dead-lettered"
  | "delayed"
  | "retrying";

export interface NotificationHealthReasonCount {
  code: string;
  count: number;
}

export interface NotificationHealthAttention {
  // Stable machine key: DEAD_LETTERED, DELAYED, REPEATED_FAILURES,
  // POSSIBLE_DUPLICATES.
  key: string;
  severity: NotificationAttentionSeverity;
  title: string;
  detail: string;
  count: number;
}

export interface NotificationHealthItem {
  eventId: string;
  eventType: string;
  state: NotificationHealthItemState;
  attempts: number;
  reasonCode: string | null;
  createdAt: string;
  // When the next attempt is due (retrying / delayed), else null.
  nextAttemptAt: string | null;
  // When it was dead-lettered, else null.
  failedAt: string | null;
  // The order number for an order notification, else null.
  reference: string | null;
  // An earlier send ended without an answer and was retried: the customer
  // may have received it twice.
  possibleDuplicate: boolean;
}

export interface NotificationHealthResponse {
  generatedAt: string;
  status: NotificationHealthStatus;
  thresholds: {
    delayedAfterSeconds: number;
    criticalDelaySeconds: number;
    repeatedFailureAttempts: number;
  };
  pending: {
    total: number;
    waiting: number;
    inProgress: number;
    scheduledRetry: number;
    delayed: number;
    // Pending notifications that have failed at least this many times.
    repeatedlyFailing: number;
    // Age of the oldest notification still pending, in seconds.
    oldestPendingAgeSeconds: number | null;
    // Age of the oldest notification that has already failed once and is
    // still pending (a retry in progress), in seconds.
    oldestRetryingAgeSeconds: number | null;
    // How long the longest-overdue notification has been due, in seconds.
    oldestOverdueSeconds: number | null;
    retryReasons: NotificationHealthReasonCount[];
  };
  failed: {
    total: number;
    last24h: number;
    last7d: number;
    reasons: NotificationHealthReasonCount[];
    // Events an operator closed on purpose at a cut-over (HISTORICAL_NOT_SENT):
    // not failures, so they are counted here and never raise an alert.
    closedDeliberately: number;
  };
  accepted: { last24h: number; last7d: number };
  possibleDuplicatesLast7d: number;
  attention: NotificationHealthAttention[];
  items: NotificationHealthItem[];
  // True when more problem notifications exist than the list shows (it is
  // capped; dead letters first, then the longest-overdue).
  itemsTruncated: boolean;
}

// --- SC3e-3: CENTERIVO subscription refunds and credits (owner decisions D1–D6) ----
// A refund (to the original payment method) or a credit (toward future
// invoices) on one of a business's PAID CENTERIVO invoices, as a Stripe credit
// note. Never a restaurant order, payment or refund. Amounts and tax are
// Stripe's own (previewed), never computed here.

export type BillingAdjustmentKind = "REFUND" | "CREDIT" | "OUT_OF_BAND";
export type BillingAdjustmentScope = "FULL" | "PARTIAL";
export type BillingAdjustmentStatus =
  | "PENDING_APPROVAL"
  | "EXECUTING"
  | "SUBMITTED"
  | "SUCCEEDED"
  | "REJECTED"
  | "CANCELED"
  | "EXPIRED"
  | "FAILED"
  | "REVIEW"
  | "RECORDED";

// The invoice as Stripe holds it now, for an adjustment request.
export interface PlatformAdjustableInvoice {
  invoiceId: string;
  number: string | null;
  currency: string;
  amountPaidMinorUnits: number;
  // Already refunded or credited (credit notes and refunds made outside them).
  adjustedMinorUnits: number;
  // What can still be refunded or credited.
  remainingMinorUnits: number;
  // A refund can go back to the original payment method (paid by a charge).
  refundable: boolean;
  // The billed period is a year or longer (a full refund needs two approvers).
  annual: boolean;
  lines: {
    lineId: string;
    description: string | null;
    // Before tax.
    amountMinorUnits: number;
  }[];
}

// POST .../tenants/:tenantId/billing/invoices/:invoiceId/adjustments/preview —
// body exactly { kind, scope, lineId?, amountMinorUnits? } (billing.
// adjustments.request): Stripe's own preview (nothing recorded or changed).
// PARTIAL names one invoice line and its pre-tax amount; Stripe adds tax.
export interface PlatformAdjustmentPreviewRequest {
  kind: "REFUND" | "CREDIT";
  scope: BillingAdjustmentScope;
  lineId?: string;
  amountMinorUnits?: number;
}
export interface PlatformAdjustmentPreview {
  kind: "REFUND" | "CREDIT";
  scope: BillingAdjustmentScope;
  currency: string;
  totalMinorUnits: number;
  taxMinorUnits: number;
  remainingAfterMinorUnits: number;
  requiredApprovals: 1 | 2;
  annualFullRefund: boolean;
}
// POST .../adjustments — the same body plus { reason } (billing.adjustments.
// request, recent sign-in): records the request with Stripe's preview.
//   409 BILLING_ADJUSTMENT_NOT_ELIGIBLE / _EXCEEDS_REMAINING / _IN_PROGRESS
export interface PlatformAdjustmentRequest extends PlatformAdjustmentPreviewRequest {
  reason: string;
}

export interface PlatformAdjustmentView {
  id: string;
  tenantId: string;
  businessName: string;
  invoiceId: string;
  invoiceNumber: string | null;
  origin: "CENTERIVO" | "EXTERNAL";
  kind: BillingAdjustmentKind;
  scope: BillingAdjustmentScope | null;
  status: BillingAdjustmentStatus;
  currency: string;
  totalMinorUnits: number;
  taxMinorUnits: number;
  annualFullRefund: boolean;
  requiredApprovals: number;
  reason: string | null;
  requestedBy: { id: string; email: string } | null;
  createdAt: string;
  expiresAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  decisions: {
    decision: "APPROVED" | "REJECTED";
    note: string;
    operator: { id: string; email: string };
    at: string;
  }[];
  events: {
    type: string;
    code: string | null;
    at: string;
    actorEmail: string | null;
    note: string | null;
  }[];
}
export interface PlatformAdjustmentListResponse {
  adjustments: PlatformAdjustmentView[];
}
// GET /api/v1/platform/billing/adjustments?status=OPEN|ALL (any operator);
// GET /api/v1/platform/tenants/:tenantId/billing/adjustments.
// POST /api/v1/platform/billing/adjustments/:adjustmentId/approve |
// /reject — body exactly { note } (billing.adjustments.approve, recent
// sign-in; never the requester; one decision per operator). The final
// approval executes it.
// POST .../adjustments/:adjustmentId/cancel — { note } (the requester).
//   409 BILLING_ADJUSTMENT_OWN_REQUEST / _NOT_PENDING / _ALREADY_DECIDED /
//       _EXPIRED / _PREVIEW_CHANGED
export interface PlatformAdjustmentDecisionRequest {
  note: string;
}
export const BILLING_ADJUSTMENT_NOT_ELIGIBLE = "BILLING_ADJUSTMENT_NOT_ELIGIBLE";
export const BILLING_ADJUSTMENT_EXCEEDS_REMAINING = "BILLING_ADJUSTMENT_EXCEEDS_REMAINING";
export const BILLING_ADJUSTMENT_IN_PROGRESS = "BILLING_ADJUSTMENT_IN_PROGRESS";
export const BILLING_ADJUSTMENT_OWN_REQUEST = "BILLING_ADJUSTMENT_OWN_REQUEST";
export const BILLING_ADJUSTMENT_NOT_PENDING = "BILLING_ADJUSTMENT_NOT_PENDING";
export const BILLING_ADJUSTMENT_ALREADY_DECIDED = "BILLING_ADJUSTMENT_ALREADY_DECIDED";
export const BILLING_ADJUSTMENT_EXPIRED = "BILLING_ADJUSTMENT_EXPIRED";
export const BILLING_ADJUSTMENT_PREVIEW_CHANGED = "BILLING_ADJUSTMENT_PREVIEW_CHANGED";

// Business (read-only): the refunds and credits on its own invoices that were
// approved and executed (pending) or completed — never requests under review.
export interface BillingInvoiceAdjustmentView {
  kind: "REFUND" | "CREDIT";
  status: "PENDING" | "COMPLETED";
  currency: string;
  totalMinorUnits: number;
  at: string;
}

// --- SC3f: CENTERIVO SaaS revenue reporting (read-only) -----------------------------
// GET /api/v1/platform/billing/reports/revenue?from=YYYY-MM&to=YYYY-MM
// (billing.reports.view). Months are calendar months in UTC, at most 24 and
// never in the future; default the last 12 including the current month.
// Only CENTERIVO subscription billing — never a restaurant's sales, orders,
// customer payments or gift cards. Every amount is per currency (never
// converted or combined) and in minor units.
//   400 an invalid period
export type RevenueReportEnvironment =
  | "STRIPE_TEST_MODE"
  | "STRIPE_LIVE_MODE"
  | "DEVELOPMENT"
  | "NO_PROVIDER";
// COMPLETE: every input was available; INCOMPLETE: some history is missing
// (counted where known, flagged); UNAVAILABLE: not computable.
export type RevenueMetricStatus = "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";

// Contracted recurring revenue (D1): monthly prices as agreed, annual / 12.
// ARR is exact (monthly x 12 + annual); MRR = ARR / 12, rounded once.
export interface RevenueRecurring {
  currency: string;
  mrrMinorUnits: number;
  arrMinorUnits: number;
  // The PAST_DUE part (included above), shown as at risk.
  atRiskMrrMinorUnits: number;
  activePaidSubscriptions: number;
  atRiskSubscriptions: number;
  monthlySubscriptions: number;
  annualSubscriptions: number;
}

export interface RevenuePlanBreakdown {
  planName: string;
  interval: "MONTH" | "YEAR";
  currency: string;
  subscriptions: number;
  mrrMinorUnits: number;
  arrMinorUnits: number;
}

export interface RevenueCash {
  currency: string;
  // Cash collected: paid invoices by payment date (includes tax). Not
  // recognized revenue — an annual invoice is collected once.
  collectedMinorUnits: number;
  // Of which tax — null when any invoice in the month lacks verified
  // amounts (never assumed zero).
  taxMinorUnits: number | null;
  // Cash refunds to payment methods through the provider (CENTERIVO and
  // external), by date.
  refundsMinorUnits: number;
  // Refunded outside the provider (recorded on a credit note), by date.
  refundsOutsideProviderMinorUnits: number;
  // Account credits issued (credit notes to the customer balance).
  creditsIssuedMinorUnits: number;
  // Customer balance applied to invoices issued this month (credits, and
  // proration credits, used — already reflected in collected cash).
  balanceAppliedMinorUnits: number;
  // Collected on invoices that had failed at least once (verified paid).
  recoveredMinorUnits: number;
}

export interface RevenueMonth {
  month: string; // YYYY-MM
  status: RevenueMetricStatus;
  // The current month: figures up to now only.
  partial: boolean;
  // Paying subscriptions whose price couldn't be found (not counted; the
  // month is INCOMPLETE).
  missingPrices: number;
  // At the end of the month (or now, for the current month).
  recurring: RevenueRecurring[];
  activePaidAtStart: number;
  activePaidAtEnd: number;
  // Paid subscriptions that actually ended (canceled) this month.
  //   ended         of those paying at the start of the month — the churn
  //                 rate is ended / activePaidAtStart (customer churn) and
  //                 churnedMrr / startMrr per currency (revenue churn);
  //   endedOther    other paid subscriptions that ended (unpaid at the
  //                 start, or started paying within the month);
  //   movedToComplimentary  paid subscriptions that became complimentary
  //                 (not churn).
  churn: {
    ended: number;
    endedOther: number;
    movedToComplimentary: number;
    revenue: {
      currency: string;
      startMrrMinorUnits: number;
      churnedMrrMinorUnits: number;
    }[];
  };
  cash: RevenueCash[];
  // Invoices issued this month with at least one failed payment attempt
  // (each counted once, however many retries).
  failedInvoices: {
    count: number;
    amountDue: { currency: string; minorUnits: number }[];
    // Issued invoices whose attempts aren't known yet (not counted).
    unverified: number;
  };
  // Failed invoices paid this month (verified payment).
  recoveredInvoices: number;
  // Complimentary arrangements active at the end of the month (businesses
  // complimentary without an arrangement have no history to count).
  complimentaryAtEnd: number;
}

export interface RevenueTrialCohort {
  month: string; // the month trials started
  started: number;
  converted: number;
  expired: number;
  inProgress: number;
  // false while any trial can still convert.
  complete: boolean;
}

export interface RevenueAdjustmentTotal {
  currency: string;
  kind: "REFUND" | "CREDIT" | "OUT_OF_BAND";
  origin: "CENTERIVO" | "EXTERNAL";
  count: number;
  totalMinorUnits: number;
}

export interface PlatformRevenueReport {
  environment: RevenueReportEnvironment;
  generatedAt: string;
  period: { from: string; to: string };
  current: {
    asOf: string;
    status: RevenueMetricStatus;
    recurring: RevenueRecurring[];
    byPlan: RevenuePlanBreakdown[];
    complimentary: {
      withArrangement: number;
      withoutArrangement: number;
      // What the arrangements' previous prices would bill — a list-price
      // equivalent, NOT lost revenue.
      listPriceEquivalent: { currency: string; mrrMinorUnits: number }[];
    };
  };
  months: RevenueMonth[];
  trialCohorts: RevenueTrialCohort[];
  // Completed refunds and credits in the period.
  adjustments: RevenueAdjustmentTotal[];
  dataQuality: {
    incompleteSubscriptions: number;
    invoicesWithoutAmounts: number;
    // Accounting invariants that failed (each a short code and count).
    violations: { code: string; count: number }[];
  };
}

// --- CENTERIVO platform: onboarding oversight (SC4e) ----------------------
// Read-only reports for operators holding onboarding.view, and the emergency
// pause of NEW owner registrations (onboarding.manage). Never a business's
// staff: these are platform routes only.

export type OwnerRegistrationStatusValue =
  | "PENDING_VERIFICATION"
  | "PASSWORD_SETUP"
  | "VERIFIED";

// What a registration needs attention for, if anything:
//   EXPIRED      never verified, and its latest code has expired;
//   STALLED      never verified, its code still valid, but stopped: the
//                mailbox is proven and the password not yet set, or every
//                attempt at the code was used;
//   NO_BUSINESS  verified, but no business was created.
export type PlatformRegistrationIssue = "EXPIRED" | "STALLED" | "NO_BUSINESS";

export const PLATFORM_REGISTRATION_FILTERS = [
  "all",
  "pending",
  "password-setup",
  "verified",
  "with-business",
  "expired",
  "stalled",
  "no-business",
] as const;
export type PlatformRegistrationFilter =
  (typeof PLATFORM_REGISTRATION_FILTERS)[number];

export interface PlatformRegistrationRow {
  id: string;
  // A verified address in full; an unverified one masked (e.g. "j***@example.com").
  email: string;
  emailMasked: boolean;
  status: OwnerRegistrationStatusValue;
  createdAt: string;
  verifiedAt: string | null;
  // When the latest code stops being accepted (unverified registrations).
  codeExpiresAt: string | null;
  codesSent: number;
  failedAttempts: number;
  business: { id: string; name: string; createdAt: string } | null;
  issue: PlatformRegistrationIssue | null;
}

// GET /api/v1/platform/onboarding/registrations
//   ?filter=&createdFrom=YYYY-MM-DD&createdTo=YYYY-MM-DD&page=&pageSize=
// Newest first. pageSize 1–50 (default 20). Anything else is a 400.
export interface PlatformRegistrationListResponse {
  items: PlatformRegistrationRow[];
  filter: PlatformRegistrationFilter;
  createdFrom: string | null;
  createdTo: string | null;
  page: number;
  pageSize: number;
  total: number;
}

export interface PlatformRegistrationControlChange {
  paused: boolean;
  reason: string;
  operatorEmail: string;
  at: string;
}

// GET /api/v1/platform/onboarding/registration-control (onboarding.view).
export interface PlatformRegistrationControlView {
  // The deployment's master switch (SELF_SERVICE_REGISTRATION_ENABLED): ON
  // only when enabled and fully configured. Operators cannot change it.
  flag: "ON" | "OFF" | "MISCONFIGURED";
  // The platform's emergency pause of NEW registrations.
  paused: boolean;
  // New registrations are accepted: flag ON and not paused.
  accepting: boolean;
  lastChange: PlatformRegistrationControlChange | null;
  // Most recent first (at most 20).
  history: PlatformRegistrationControlChange[];
  quota: {
    // New registrations allowed per rolling 24 hours; null when the
    // configured value is malformed.
    limit: number | null;
    // Created in the last 24 hours (the count registration enforces).
    usedInWindow: number;
    windowHours: 24;
    // While the quota is used up: when the oldest counted registration
    // leaves the window, freeing a place.
    nextFreeAt: string | null;
    asOf: string;
  };
  issues: { expired: number; stalled: number; verifiedWithoutBusiness: number };
}

// POST /api/v1/platform/onboarding/registration-control
// (onboarding.manage, recent sign-in; audited). Body exactly
// { paused, reason } — reason 10–500 characters. 409
// REGISTRATION_CONTROL_UNCHANGED when it is already in that state.
// Returns PlatformRegistrationControlView.
export interface PlatformRegistrationControlRequest {
  paused: boolean;
  reason: string;
}
export const REGISTRATION_CONTROL_UNCHANGED = "REGISTRATION_CONTROL_UNCHANGED";

export const PLATFORM_ONBOARDING_FILTERS = [
  "all",
  "awaiting-payment",
  "missing-location",
  "missing-hours",
  "missing-menu",
  "ordering-off",
  "stuck",
] as const;
export type PlatformOnboardingFilter =
  (typeof PLATFORM_ONBOARDING_FILTERS)[number];

export const PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT = 7;

export interface PlatformOnboardingBusinessRow {
  tenantId: string;
  name: string;
  slug: string;
  tenantStatus: "ACTIVE" | "SUSPENDED";
  registeredAt: string;
  businessCreatedAt: string;
  // The business's own getting-started checklist (SC4d), as it sees it.
  steps: GettingStartedStep[];
  completedCount: number;
  totalCount: number;
  setupComplete: boolean;
  // Not complete, and the business was created more than stuckDays ago.
  stuck: boolean;
}

// GET /api/v1/platform/onboarding/businesses?filter=&stuckDays=&page=&pageSize=
// Self-service businesses, most recently created first. stuckDays 1–90
// (default 7). The progress is computed live for at most the `scanLimit`
// most recent businesses; `truncated` says older ones were not included.
export interface PlatformOnboardingBusinessListResponse {
  items: PlatformOnboardingBusinessRow[];
  filter: PlatformOnboardingFilter;
  stuckDays: number;
  page: number;
  pageSize: number;
  total: number;
  scanned: number;
  scanLimit: number;
  truncated: boolean;
  summary: {
    businesses: number;
    complete: number;
    awaitingPayment: number;
    missingLocation: number;
    missingHours: number;
    missingMenu: number;
    orderingOff: number;
    stuck: number;
  };
}

// --- CENTERIVO storefront routing (SC4f) ---------------------------------
// Each business's storefront is served at an APPROVED hostname from a
// database registry (StorefrontHost) — its platform subdomain
// "{slug}.{storefront domain}", a legacy address (Mocha House's existing
// ones) or, later, a custom domain. Nothing ever falls back to a default
// business for an unknown or unpublished hostname.

// The signed storefront context the web server sends with every API call
// it makes for a storefront visitor: the hostname it trusts, a timestamp
// and an HMAC-SHA256 over "storefront-host:v1:<seconds>:<hostname>" with a
// secret shared only by the web tier and the API. A browser cannot produce
// it, so it can never choose its own business.
export const STOREFRONT_HOST_HEADER = "x-centerivo-storefront-host";
export const STOREFRONT_HOST_TIMESTAMP_HEADER = "x-centerivo-storefront-ts";
export const STOREFRONT_HOST_SIGNATURE_HEADER = "x-centerivo-storefront-sig";
export const STOREFRONT_CONTEXT_MAX_SKEW_SECONDS = 60;

export function storefrontContextMessage(hostname: string, seconds: number): string {
  return `storefront-host:v1:${seconds}:${hostname}`;
}

// Answer for an unsigned or invalid context, an unknown hostname or an
// unpublished one alike (404): nothing reveals which businesses exist.
export const STOREFRONT_NOT_FOUND = "STOREFRONT_NOT_FOUND";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A hostname in the one form the registry stores and matches: lower case,
// no port, no trailing dot, ASCII (internationalised names in their
// "xn--" form), every label 1–63 characters of letters, digits and inner
// hyphens, 253 characters at most, at least two labels — or "localhost"
// for local development. Null for anything else (an IP address included).
export function normalizeStorefrontHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (host === "" || host.length > 260) return null;
  // A port, if any (an IPv6 literal is refused below anyway).
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost") return host;
  if (host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => HOST_LABEL.test(label))) return null;
  // An IPv4 address is not a storefront.
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  return host;
}

// Labels a business slug may never take as its subdomain: names the
// platform uses or may use, and ones that would mislead customers.
export const RESERVED_STOREFRONT_LABELS: readonly string[] = [
  "www", "api", "app", "admin", "platform", "console", "internal", "staff",
  "mail", "email", "smtp", "imap", "pop", "ftp", "ns", "ns1", "ns2", "dns",
  "cdn", "static", "assets", "media", "img", "images", "files", "status",
  "help", "support", "docs", "blog", "billing", "pay", "payments", "checkout",
  "account", "accounts", "auth", "login", "signin", "signup", "register",
  "centerivo", "test", "dev", "staging", "stage", "demo", "sandbox", "local",
  "localhost", "root", "system", "security", "webhooks", "health",
];

// Whether a business slug can be used as its storefront subdomain label:
// a DNS label (at most 63 characters, letters, digits and single inner
// hyphens — the business slug format) that is not reserved.
export function isUsableStorefrontLabel(slug: unknown): boolean {
  return (
    typeof slug === "string" &&
    slug.length >= 1 &&
    slug.length <= 63 &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
    !RESERVED_STOREFRONT_LABELS.includes(slug)
  );
}

// "{slug}.{storefront domain}", normalized; null when the slug is not usable
// or the domain is not a valid hostname.
export function platformStorefrontHost(slug: string, storefrontDomain: string): string | null {
  if (!isUsableStorefrontLabel(slug)) return null;
  const domain = normalizeStorefrontHost(storefrontDomain);
  if (!domain || domain === "localhost") return null;
  return normalizeStorefrontHost(`${slug}.${domain}`);
}

// --- SC4f-3a: storefront publishing (Platform Console) -----------------------
// Operators holding storefront.manage assign an APPROVED address to a business
// (its platform subdomain, or — for Mocha House only — an address listed in
// trusted configuration), then publish or unpublish it, each with a recent
// sign-in, a written reason and the business's slug typed to confirm.
// Publishing a registry row does not by itself make a storefront public: the
// deployment's host routing switch must also be on.

export type StorefrontHostKind = "PLATFORM_SUBDOMAIN" | "LEGACY" | "CUSTOM";
export type StorefrontHostAction = "ASSIGNED" | "PUBLISHED" | "UNPUBLISHED";

// The publishing checks, in checklist order. Digital ordering is NOT one of
// them: a published storefront may be browse-only.
export const STOREFRONT_PUBLISHING_CHECKS = [
  "business_active",
  "billing_authorized",
  "location_configured",
  "menu_available",
] as const;
export type StorefrontPublishingCheck =
  (typeof STOREFRONT_PUBLISHING_CHECKS)[number];

export const STOREFRONT_NOT_ELIGIBLE = "STOREFRONT_NOT_ELIGIBLE";
export const STOREFRONT_HOST_TAKEN = "STOREFRONT_HOST_TAKEN";
export const STOREFRONT_HOST_UNCHANGED = "STOREFRONT_HOST_UNCHANGED";
export const STOREFRONT_SLUG_MISMATCH = "STOREFRONT_SLUG_MISMATCH";
export const STOREFRONT_ASSIGNMENT_UNAVAILABLE =
  "STOREFRONT_ASSIGNMENT_UNAVAILABLE";

export interface PlatformStorefrontHostView {
  id: string;
  hostname: string;
  kind: StorefrontHostKind;
  // Published in the registry.
  published: boolean;
  publishedAt: string | null;
  // Actually served to the public: published AND host routing switched on.
  live: boolean;
  createdAt: string;
}

export interface PlatformStorefrontHistoryEntry {
  id: string;
  action: StorefrontHostAction;
  hostname: string;
  reason: string;
  actorEmail: string;
  createdAt: string;
}

// GET /api/v1/platform/tenants/:tenantId/storefront (storefront.manage).
export interface PlatformStorefrontView {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: PlatformTenantStatus;
  };
  // The deployment's host routing switch (STOREFRONT_HOST_ROUTING_ENABLED).
  // While false, no storefront address is publicly live, published or not.
  hostRouting: boolean;
  hosts: PlatformStorefrontHostView[];
  eligibility: {
    eligible: boolean;
    checks: Array<{ key: StorefrontPublishingCheck; passed: boolean }>;
  };
  assignable: {
    // The business's platform subdomain, when it can be assigned now.
    platformHostname: string | null;
    // Why not, otherwise.
    platformUnavailable:
      | "domain_not_configured"
      | "slug_not_usable"
      | "reserved_for_legacy"
      | "already_assigned"
      | "taken"
      | null;
    // Mocha House only: approved existing addresses not yet assigned.
    legacyHostnames: string[];
  };
  // Most recent first (at most 50).
  history: PlatformStorefrontHistoryEntry[];
}

// POST /api/v1/platform/tenants/:tenantId/storefront/hosts
export interface PlatformStorefrontAssignRequest {
  kind: "PLATFORM_SUBDOMAIN" | "LEGACY";
  // LEGACY only: one of the approved addresses.
  hostname?: string;
  reason: string;
  confirmSlug: string;
}

// POST .../storefront/hosts/:hostId/publish and .../unpublish
export interface PlatformStorefrontChangeRequest {
  reason: string;
  confirmSlug: string;
}

// --- ESP-03 PR 5: payment reconciliation support (Platform Console) -------------
// Restaurant payment reconciliation cases, read by CENTERIVO platform support
// (payments.reconciliation.view) and acted on — a safe recovery attempt, an
// internal note — with payments.reconciliation.manage plus a recent sign-in.
// A recovery NEVER charges again: it only creates the missing order (or issues
// the missing gift card) of a payment already confirmed as SUCCEEDED. Nothing
// here can invent a payment, a refund or an outcome the payment provider has
// not confirmed. No card data, gift-card codes or customer contact details are
// ever part of these views.

export const PAYMENT_CASE_CATEGORIES = [
  // Payment confirmed, order / gift card still missing, and no recovery is
  // running: support should look (failed, exhausted or waiting recovery).
  "NEEDS_ATTENTION",
  // A recovery attempt is running right now.
  "RECOVERY_IN_PROGRESS",
  // Resolved: the order or gift card exists.
  "RECOVERED",
  // The payment's outcome is not confirmed (held, unknown, never sent):
  // nothing can be recovered until the provider's outcome is verified.
  "AWAITING_PAYMENT_OUTCOME",
  // Resolved for another documented reason.
  "CLOSED",
] as const;
export type PaymentCaseCategory = (typeof PAYMENT_CASE_CATEGORIES)[number];

export type PaymentCaseStatus = "OPEN" | "IN_REVIEW" | "RESOLVED";
export type PaymentCasePurchaseKind = "ORDER" | "GIFT_CARD" | "UNKNOWN";

export interface PlatformPaymentCaseRecovery {
  // A saved checkout (or a gift-card purchase without its card) exists, so a
  // recovery can be attempted.
  recoverable: boolean;
  automaticAttempts: number;
  lastFailure: string | null;
  lastFailureAt: string | null;
  // Automatic recovery switched on and a further automatic attempt is due at
  // this time; null when none will be made.
  nextAutomaticAttemptAt: string | null;
}

export interface PlatformPaymentCaseSummary {
  id: string;
  tenant: { id: string; name: string };
  status: PaymentCaseStatus;
  category: PaymentCaseCategory;
  reasonCode: string;
  resolution: string | null;
  purchaseKind: PaymentCasePurchaseKind;
  payment: {
    id: string;
    amountMinorUnits: number;
    currency: string;
    status: string;
    paymentState: string | null;
    fulfilmentStatus: string | null;
    providerReference: string | null;
  };
  order: { id: string; orderNumber: string } | null;
  giftCardPurchase: { id: string; issued: boolean } | null;
  recovery: PlatformPaymentCaseRecovery;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// GET /api/v1/platform/payment-cases
export interface PlatformPaymentCaseListResponse {
  cases: PlatformPaymentCaseSummary[];
  automaticRecoveryEnabled: boolean;
  // More cases matched than were returned (narrow the filters).
  truncated: boolean;
}

export interface PlatformPaymentCaseEvent {
  id: string;
  action: string;
  // SYSTEM, or RESTAURANT_STAFF for a restaurant user's action (never named).
  actor: "SYSTEM" | "RESTAURANT_STAFF";
  // Fixed machine codes and record references only.
  detail: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface PlatformPaymentCaseNote {
  id: string;
  body: string;
  authorEmail: string;
  createdAt: string;
}

// GET /api/v1/platform/payment-cases/:caseId
export interface PlatformPaymentCaseDetail {
  case: PlatformPaymentCaseSummary;
  events: PlatformPaymentCaseEvent[];
  notes: PlatformPaymentCaseNote[];
  automaticRecoveryEnabled: boolean;
}

// POST /api/v1/platform/payment-cases/:caseId/recover
export interface PlatformPaymentCaseRecoverRequest {
  reason: string;
}
export type PaymentRecoveryResult =
  | "RECOVERED"
  | "ALREADY_FULFILLED"
  | "FAILED";
export interface PlatformPaymentCaseRecoverResponse {
  result: PaymentRecoveryResult;
  failure: string | null;
  detail: PlatformPaymentCaseDetail;
}

// POST /api/v1/platform/payment-cases/:caseId/notes
export interface PlatformPaymentCaseNoteRequest {
  body: string;
}

export const PAYMENT_CASE_NOTE_MAX_LENGTH = 1000;
export const PAYMENT_CASE_REASON_MIN_LENGTH = 10;
export const PAYMENT_CASE_REASON_MAX_LENGTH = 500;

// Refusal codes (409) of a recovery request.
export const PAYMENT_RECOVERY_NOT_CONFIRMED = "PAYMENT_RECOVERY_NOT_CONFIRMED";
export const PAYMENT_RECOVERY_NOTHING_TO_RECOVER =
  "PAYMENT_RECOVERY_NOTHING_TO_RECOVER";
export const PAYMENT_RECOVERY_IN_PROGRESS = "PAYMENT_RECOVERY_IN_PROGRESS";
export const PAYMENT_RECOVERY_CASE_RESOLVED = "PAYMENT_RECOVERY_CASE_RESOLVED";

// --- ESP-03 PR 6: server-owned checkout sessions --------------------------------
// POST /api/v1/orders/checkout-sessions — start (or resume) the checkout a
// food-order payment and all of its retries are bound to. The server creates
// the session for the request's business, the location and (when signed in)
// the customer, and generates every payment key itself. Pass the token from
// an earlier response to resume it: a token that is still valid for this
// business, location and customer is kept (a held or completed payment is
// reported, never charged again); otherwise a new session is started.
export interface CheckoutSessionRequest {
  locationId: string;
  checkoutToken?: string | null;
}

// OPEN — no live payment: an order can be placed (new attempts are accepted
//   until `acceptsNewPaymentsUntil`).
// IN_PROGRESS — a payment is being sent, held, awaiting confirmation, or was
//   taken and its order is still being created: do NOT pay again.
// COMPLETED — paid and the order exists (`confirmation` is included, for
//   this session's holder only).
export type CheckoutSessionState = "OPEN" | "IN_PROGRESS" | "COMPLETED";

export interface CheckoutSessionResponse {
  // Returned to API clients; the web storefront's server keeps it in an
  // HttpOnly cookie and never forwards it to browser code.
  checkoutToken: string;
  state: CheckoutSessionState;
  acceptsNewPaymentsUntil: string;
  confirmation: OrderConfirmation | null;
}

// Refusal codes.
export const CLIENT_PAYMENT_KEY_NOT_ACCEPTED = "CLIENT_PAYMENT_KEY_NOT_ACCEPTED";
export const CHECKOUT_SESSION_INVALID = "CHECKOUT_SESSION_INVALID";
export const CHECKOUT_SESSION_EXPIRED = "CHECKOUT_SESSION_EXPIRED";
// The checkout changed while a payment for its earlier version is live
// (nothing new is charged; the earlier payment stands).
export const CHECKOUT_CHANGED_DURING_PAYMENT = "CHECKOUT_CHANGED_DURING_PAYMENT";
// The session's payment is complete; a new order needs a new checkout.
export const CHECKOUT_ALREADY_COMPLETED = "CHECKOUT_ALREADY_COMPLETED";
// ESP-03 PR 8 — a promotion redemption, Mocha Beans or gift-card balance the
// order needs is no longer available (nothing was charged; review the order).
export const CHECKOUT_RESOURCE_UNAVAILABLE = "CHECKOUT_RESOURCE_UNAVAILABLE";

// --- ESP-04 M1: restaurant payment account (Stripe Connect) -------------------
// The restaurant's OWN Stripe account for customer payments — never
// CENTERIVO's subscription billing. Owner only (payments.connect plus the
// built-in administrator role). Readiness always comes from the account as
// last read back from Stripe, never from returning from onboarding. Customer
// payments stay disabled (paymentsEnabled is always false in this milestone).

// NOT_CONNECTED       no account yet;
// SETUP_IN_PROGRESS   an account exists; Stripe still needs information;
// UNDER_REVIEW        nothing more is asked; Stripe is reviewing it;
// ACTION_REQUIRED     Stripe needs more information (past due or restricted);
// READY               card payments are active and the configuration is the
//                     approved one (restaurant pays fees, full dashboard,
//                     Stripe-managed losses);
// NOT_SUPPORTED       Stripe cannot offer card payments to this business;
// CLOSED              the account was closed;
// CONFIGURATION_MISMATCH  Stripe reports a configuration other than the
//                     approved one: never treated as ready.
export const PAYMENT_ACCOUNT_STATES = [
  "NOT_CONNECTED",
  "SETUP_IN_PROGRESS",
  "UNDER_REVIEW",
  "ACTION_REQUIRED",
  "READY",
  "NOT_SUPPORTED",
  "CLOSED",
  "CONFIGURATION_MISMATCH",
] as const;
export type PaymentAccountState = (typeof PAYMENT_ACCOUNT_STATES)[number];

// GET /api/v1/admin/payments/account and
// POST /api/v1/admin/payments/account/refresh (payments.connect).
export interface AdminPaymentAccountResponse {
  // False when no restaurant-payments provider is configured here.
  providerAvailable: boolean;
  state: PaymentAccountState;
  // The connected account's id (acct_…), shown so the owner can match it in
  // their Stripe Dashboard; null before one exists.
  accountId: string | null;
  testMode: boolean;
  // Requirements Stripe is waiting for from the restaurant.
  requirementsDue: number;
  // When the status was last read back from Stripe (ISO 8601), if ever.
  lastCheckedAt: string | null;
  // Customer payments are not available yet (ESP-04 M1): always false.
  paymentsEnabled: false;
}

// POST /api/v1/admin/payments/account/onboarding (payments.connect; no
// body). Creates the restaurant's account if it has none — at most one per
// business, never a duplicate — and returns Stripe's hosted onboarding page.
export interface AdminPaymentOnboardingResponse {
  url: string;
}

// Refusal codes.
export const PAYMENTS_PROVIDER_UNAVAILABLE = "PAYMENTS_PROVIDER_UNAVAILABLE";
export const PAYMENT_ACCOUNT_OWNER_ONLY = "PAYMENT_ACCOUNT_OWNER_ONLY";
// An earlier account request was never completed and is past the provider's
// idempotency window: support checks it (never a silent second account).
export const PAYMENT_ACCOUNT_NEEDS_SUPPORT = "PAYMENT_ACCOUNT_NEEDS_SUPPORT";
