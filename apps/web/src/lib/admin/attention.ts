import type { LocationSummary } from "@mocha-house/contracts";
import { canAtLocation, type AdminCapabilities } from "./capabilities";

export interface AttentionItem {
  id: string;
  // Milestone 5C only surfaces "warning" (digital ordering disabled) and
  // "info". No fabricated "critical" severity — there is no data source for
  // one yet.
  severity: "info" | "warning";
  title: string;
  description: string;
  // Omitted in 5C where the responsible module doesn't exist yet.
  href?: string;
}

// Digital-ordering "needs attention" items. A disabled location is surfaced
// ONLY when locations.manage_digital_ordering is effective FOR THAT SPECIFIC
// location — corporate, or that location is one of the permission's explicit
// scopes. It is never inferred from the general visible-location set, so a
// manager scoped to Location A does not see Location B even when both are
// disabled and both are visible.
export function digitalOrderingAttentionItems(
  locations: readonly LocationSummary[],
  capabilities: AdminCapabilities,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const location of locations) {
    if (
      !location.isDigitalOrderingEnabled &&
      canAtLocation(
        capabilities,
        "locations.manage_digital_ordering",
        location.id,
      )
    ) {
      items.push({
        id: `digital-ordering-${location.id}`,
        severity: "warning",
        title: "Online ordering is off",
        description: `${location.name} — customers can't place online orders here.`,
        // Milestone 5D-2: link straight to the location so an authorized
        // user can turn it back on. The location detail page carries the
        // Online Ordering control for anyone who can manage it here.
        href: `/admin/locations/${location.id}`,
      });
    }
  }
  return items;
}
