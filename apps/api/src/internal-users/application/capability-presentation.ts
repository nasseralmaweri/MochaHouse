import {
  INTERNAL_PERMISSION_KEYS,
  type AdminUserCapabilityGroup,
  type InternalPermissionKey,
} from '@mocha-house/contracts';

// The ONE place internal permissions become plain business language for the
// Administration screens (Milestone 5E). It is a PRESENTATION layer only —
// the authorization engine (AuthorizationService / AuthorizationContext /
// the guards) remains the sole authority. This module never decides
// anything; it only describes.
//
// Every key has three phrasings:
//   effectiveAll    — a specific person who holds it for every location.
//   effectiveScoped — a specific person who holds it only for some
//                     locations ("their locations").
//   definition      — what an ACCESS LEVEL (role) includes, scope-agnostic
//                     ("View orders", not "…at all locations"). A role is a
//                     template; scope is decided when it is assigned.
//
// The Record<InternalPermissionKey, …> is exhaustive: adding a permission
// to INTERNAL_PERMISSION_KEYS without wording here is a compile error, so no
// capability can ever ship without human phrasing.
interface PermissionWording {
  group: string;
  effectiveAll: string;
  effectiveScoped: string;
  definition: string;
}

const WORDING: Record<InternalPermissionKey, PermissionWording> = {
  'orders.view': {
    group: 'Orders',
    effectiveAll: 'View orders at all locations',
    effectiveScoped: 'View orders at their locations',
    definition: 'View orders',
  },
  'orders.manage_status': {
    group: 'Orders',
    effectiveAll: 'Update order status at all locations',
    effectiveScoped: 'Update order status at their locations',
    definition: 'Update order status',
  },
  'catalog.view': {
    group: 'Menu & Products',
    effectiveAll: 'View the full product catalogue',
    effectiveScoped: 'View the full product catalogue',
    definition: 'View products and menus',
  },
  'catalog.products.edit': {
    group: 'Menu & Products',
    effectiveAll: 'Edit standard product information',
    effectiveScoped: 'Edit standard product information',
    definition: 'Edit standard product information',
  },
  'catalog.menu.manage': {
    group: 'Menu & Products',
    effectiveAll: 'Manage which products are shown on menus',
    effectiveScoped: 'Manage which products are shown on menus',
    definition: 'Manage which products are shown on menus',
  },
  'catalog.overrides.manage': {
    group: 'Menu & Products',
    effectiveAll: 'Set prices and availability for all locations',
    effectiveScoped: 'Set prices and availability for their locations',
    definition: 'Set location prices and availability',
  },
  'locations.view': {
    group: 'Locations',
    effectiveAll: 'View all locations',
    effectiveScoped: 'View their locations',
    definition: 'View locations',
  },
  'locations.edit': {
    group: 'Locations',
    effectiveAll: 'Edit location information',
    effectiveScoped: 'Edit location information',
    definition: 'Edit location information',
  },
  'locations.manage_digital_ordering': {
    group: 'Locations',
    effectiveAll: 'Turn online ordering on or off for all locations',
    effectiveScoped: 'Turn online ordering on or off for their locations',
    definition: 'Turn online ordering on or off',
  },
  'users.view': {
    group: 'Administration',
    effectiveAll: 'View Admin users',
    effectiveScoped: 'View Admin users',
    definition: 'View Admin users',
  },
  'roles.view': {
    group: 'Administration',
    effectiveAll: 'View access levels',
    effectiveScoped: 'View access levels',
    definition: 'View access levels',
  },
};

const GROUP_ORDER = [
  'Orders',
  'Menu & Products',
  'Locations',
  'Administration',
];

// A single display order used by BOTH screens so the user-detail and
// access-level-detail lists read consistently. "View" before "edit/manage"
// within each group.
const KEY_DISPLAY_ORDER: InternalPermissionKey[] = [
  'orders.view',
  'orders.manage_status',
  'catalog.view',
  'catalog.products.edit',
  'catalog.menu.manage',
  'catalog.overrides.manage',
  'locations.view',
  'locations.edit',
  'locations.manage_digital_ordering',
  'users.view',
  'roles.view',
];

function groupLines(
  lineFor: (key: InternalPermissionKey) => string | null,
): AdminUserCapabilityGroup[] {
  const itemsByGroup = new Map<string, string[]>();
  for (const key of KEY_DISPLAY_ORDER) {
    const line = lineFor(key);
    if (line === null) {
      continue;
    }
    const group = WORDING[key].group;
    const list = itemsByGroup.get(group) ?? [];
    list.push(line);
    itemsByGroup.set(group, list);
  }
  return GROUP_ORDER.filter((group) => itemsByGroup.has(group)).map(
    (group) => ({
      group,
      items: itemsByGroup.get(group) as string[],
    }),
  );
}

// A PERSON'S effective access — `capabilities` is the map from
// AuthorizationContext.summarize() (already filtered to known keys). Uses
// the "all locations" / "their locations" phrasing per permission.
export function describeEffectiveCapabilities(
  capabilities: Partial<Record<InternalPermissionKey, { corporate: boolean }>>,
): AdminUserCapabilityGroup[] {
  return groupLines((key) => {
    const capability = capabilities[key];
    if (!capability) {
      return null;
    }
    return capability.corporate
      ? WORDING[key].effectiveAll
      : WORDING[key].effectiveScoped;
  });
}

// An ACCESS LEVEL'S template — `permissionKeys` is the set of KNOWN
// permission keys stored on the role (unknown keys must be filtered out by
// the caller). Scope-agnostic phrasing.
export function describeAccessLevelCapabilities(
  permissionKeys: ReadonlySet<InternalPermissionKey>,
): AdminUserCapabilityGroup[] {
  return groupLines((key) =>
    permissionKeys.has(key) ? WORDING[key].definition : null,
  );
}

// Every permission in the closed vocabulary that has wording here — i.e.
// all of them (the Record is exhaustive). Exposed for the test that guards
// that invariant.
export const PERMISSIONS_WITH_WORDING: readonly InternalPermissionKey[] =
  INTERNAL_PERMISSION_KEYS.filter((key) => key in WORDING);
