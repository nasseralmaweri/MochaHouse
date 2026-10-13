import {
  TENANT_RELATIONSHIPS,
  type TenantRelationship,
} from '@mocha-house/database';

// Models created AFTER the tenant-conversion migrations. Several migration
// regression suites are pinned to the schema exactly as it existed at one
// migration (they apply only the migrations up to that point) but derive their
// list of tenant-owned tables from the CURRENT MODEL_TENANCY registry; a model
// that did not exist yet at that point must be excluded from that list.
//   NotificationRecipient        Milestone S0D-2C-3
//   PaymentReconciliationCase    ESP-03 PR 1
//   PaymentReconciliationEvent   ESP-03 PR 1
export const MODELS_ADDED_LATER: ReadonlySet<string> = new Set([
  'NotificationRecipient',
  'PaymentReconciliationCase',
  'PaymentReconciliationEvent',
]);

// The relationship inventory as it applied to a database from BEFORE the models
// above existed: for historical-state suites that run the integrity checker
// against a scratch database migrated only up to an older migration.
export const TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS: readonly TenantRelationship[] =
  TENANT_RELATIONSHIPS.filter(
    (relationship) =>
      !MODELS_ADDED_LATER.has(relationship.model) &&
      !(
        'target' in relationship && MODELS_ADDED_LATER.has(relationship.target)
      ),
  );
