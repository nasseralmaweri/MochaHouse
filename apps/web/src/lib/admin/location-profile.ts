import {
  COUNTRY_CODES,
  supportedTimeZones,
  type AdminLocationProfile,
} from "@mocha-house/contracts";

// SC4d — choices and display for a location's profile. Built on the server
// (the same runtime family as the API's validation) and passed to the form,
// so the options a browser shows never differ from what the API accepts and
// server and client render identical markup.

export interface ChoiceOption {
  value: string;
  label: string;
}

export function countryOptions(locale = "en"): ChoiceOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return COUNTRY_CODES.map((code) => ({
    value: code,
    label: names.of(code) ?? code,
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

export function countryName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// "America/Argentina/Buenos_Aires" -> "America / Argentina / Buenos Aires".
export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ").split("/").join(" / ");
}

export function timeZoneOptions(): ChoiceOption[] {
  return [...supportedTimeZones()]
    .sort((a, b) => a.localeCompare(b))
    .map((zone) => ({ value: zone, label: timeZoneLabel(zone) }));
}

// The postal address as display lines; empty when nothing is set.
export function addressLines(profile: AdminLocationProfile): string[] {
  const lines: string[] = [];
  if (profile.addressLine1) lines.push(profile.addressLine1);
  if (profile.addressLine2) lines.push(profile.addressLine2);
  const cityLine = [
    profile.city,
    [profile.region, profile.postalCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  if (cityLine) lines.push(cityLine);
  if (profile.countryCode) lines.push(countryName(profile.countryCode));
  return lines;
}

export function isProfileComplete(profile: AdminLocationProfile): boolean {
  return Boolean(
    profile.addressLine1 &&
      profile.city &&
      profile.countryCode &&
      profile.timeZone &&
      profile.phone,
  );
}
