// SC1b — the CENTERIVO platform console's navigation. Only modules that are
// actually built are links; the rest are listed as "Coming soon" and are not
// navigable (no placeholder screens, no invented data).

export type PlatformNavKey =
  | "overview"
  | "tenants"
  | "onboarding"
  | "plans"
  | "subscriptions"
  | "billing"
  | "support"
  | "settings";

export interface PlatformNavItem {
  key: PlatformNavKey;
  label: string;
  href: string | null; // null = not available yet
  description: string;
}

export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  {
    key: "overview",
    label: "Overview",
    href: "/platform",
    description: "Platform status at a glance.",
  },
  {
    key: "tenants",
    label: "Tenants",
    href: "/platform/tenants",
    description: "Businesses on CENTERIVO and their lifecycle.",
  },
  {
    key: "onboarding",
    label: "Onboarding",
    href: "/platform/onboarding",
    description: "Owner sign-ups, setup progress and the registration pause.",
  },
  {
    key: "plans",
    label: "Plans",
    href: "/platform/plans",
    description: "Plans, modules and entitlements.",
  },
  {
    key: "subscriptions",
    label: "Subscriptions",
    href: null,
    description: "Each business's subscription and trial.",
  },
  {
    key: "billing",
    label: "Billing",
    href: "/platform/billing",
    description: "Billing reconciliation (Stripe test mode).",
  },
  {
    key: "support",
    label: "Support",
    href: null,
    description: "Audited support access and diagnostics.",
  },
  {
    key: "settings",
    label: "Settings",
    href: null,
    description: "Platform configuration and operators.",
  },
];

export function isAvailable(item: PlatformNavItem): boolean {
  return item.href !== null;
}

// SC1c — Overview is current only on /platform itself; a module stays current
// on its own sub-pages (e.g. a tenant's detail page under Tenants).
export function isCurrentNavItem(
  item: PlatformNavItem,
  pathname: string | null,
): boolean {
  if (!item.href || !pathname) return false;
  if (item.href === "/platform") return pathname === "/platform";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
