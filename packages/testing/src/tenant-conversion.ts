// TEST-ONLY record of S0D progress: the tenant-owned models whose tenantId
// is REQUIRED (NOT NULL) so far. Schema-introspection tests assert exactly
// these are NOT NULL and every other tenant-owned model is still nullable.
// Each S0D-2 slice appends its models here, in the same change that sets
// them NOT NULL.
export const TENANT_ID_REQUIRED_MODELS: readonly string[] = [
  // S0D-2A — locations, catalog, menu, pricing & store operations.
  'Location',
  'Category',
  'Product',
  'Menu',
  'ModifierGroup',
  'ModifierOption',
  'ProductModifierGroup',
  'MenuProduct',
  'LocationMenu',
  'LocationProductPriceOverride',
  'LocationProductAvailabilityOverride',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'OperationsTask',
];
