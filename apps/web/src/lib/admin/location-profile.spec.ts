import {
  COUNTRY_CODES,
  validateLocationProfile,
  type AdminLocationProfile,
} from "@mocha-house/contracts";
import {
  addressLines,
  countryOptions,
  isProfileComplete,
  timeZoneLabel,
  timeZoneOptions,
} from "./location-profile";

const valid = {
  name: "  Harbor   Street Cafe ",
  addressLine1: "12 Harbor Street",
  city: "Portland",
  region: "ME",
  postalCode: "04101-abc",
  countryCode: "us",
  timeZone: "America/New_York",
  phone: "+1 (207) 555-0134",
};

describe("location profile rule and display (SC4d)", () => {
  it("normalizes a valid profile", () => {
    const result = validateLocationProfile(valid);
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Harbor Street Cafe",
        addressLine1: "12 Harbor Street",
        addressLine2: null,
        city: "Portland",
        region: "ME",
        postalCode: "04101-ABC",
        countryCode: "US",
        timeZone: "America/New_York",
        phone: "+1 (207) 555-0134",
      },
    });
  });

  it("names the first field that is wrong", () => {
    const fieldOf = (overrides: Record<string, unknown>) => {
      const result = validateLocationProfile({ ...valid, ...overrides });
      return result.ok ? null : result.field;
    };
    expect(fieldOf({ name: "" })).toBe("name");
    expect(fieldOf({ city: "Port\u0007land" })).toBe("city");
    // Tabs and line breaks are not refused: they collapse into spaces.
    expect(fieldOf({ addressLine1: "12\tHarbor\nStreet" })).toBeNull();
    expect(fieldOf({ addressLine1: 42 })).toBe("addressLine1");
    expect(fieldOf({ city: "x".repeat(101) })).toBe("city");
    expect(fieldOf({ postalCode: "04101!" })).toBe("postalCode");
    expect(fieldOf({ countryCode: "ZZ" })).toBe("countryCode");
    expect(fieldOf({ timeZone: "EST" })).toBe("timeZone");
    expect(fieldOf({ phone: "555-01" })).toBe("phone");
    expect(fieldOf({ phone: "+1 555 0134 ext 2" })).toBe("phone");
    expect(fieldOf({ region: undefined, postalCode: null })).toBeNull();
  });

  it("offers every country and the runtime's IANA time zones", () => {
    const countries = countryOptions();
    expect(countries).toHaveLength(COUNTRY_CODES.length);
    expect(countries.find((c) => c.value === "US")?.label).toBe(
      "United States",
    );
    const zones = timeZoneOptions().map((zone) => zone.value);
    expect(zones).toContain("America/New_York");
    expect(zones).toContain("UTC");
    expect(zones).not.toContain("EST");
    expect(timeZoneLabel("America/Argentina/Buenos_Aires")).toBe(
      "America / Argentina / Buenos Aires",
    );
  });

  it("formats the address and knows when the profile is complete", () => {
    const profile: AdminLocationProfile = {
      addressLine1: "12 Harbor Street",
      addressLine2: "Unit 4",
      city: "Portland",
      region: "ME",
      postalCode: "04101",
      countryCode: "US",
      timeZone: "America/New_York",
      phone: "+1 207 555 0134",
    };
    expect(addressLines(profile)).toEqual([
      "12 Harbor Street",
      "Unit 4",
      "Portland, ME 04101",
      "United States",
    ]);
    expect(isProfileComplete(profile)).toBe(true);
    expect(isProfileComplete({ ...profile, timeZone: null })).toBe(false);
    expect(
      addressLines({
        ...profile,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
      }),
    ).toEqual([]);
  });
});
