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
//   OrderClosure                 R1 / S5a
//   OrderRefundObligation        R1 / S5a
//   TenantBillingContact         SC3c-3
//   LocationOpeningPeriod        SC4d
//   CheckoutSnapshot             ESP-03 PR 4
//   CheckoutSession              ESP-03 PR 6
//   FinancialHold                ESP-03 PR 8
//   TenantPaymentAccount         ESP-04 M1
//   PaymentReconciliationNote    ESP-03 PR 5
//   PaymentRefund                ESP-04 M5a
//   PaymentRefundEvent           ESP-04 M5a
//   TaxClass                     V1 Sales Tax PR 1
//   LocationTaxVersion           V1 Sales Tax PR 1
//   LocationTaxComponent         V1 Sales Tax PR 1
//   LocationTaxComponentClass    V1 Sales Tax PR 1
//   OrderTaxSnapshot             V1 Sales Tax PR 2
//   OrderTaxRefund               V1 Sales Tax PR 3
//   OrderTaxRefundLine           V1 Sales Tax PR 3
//   OrderTaxRefundComponent      V1 Sales Tax PR 3
export const MODELS_ADDED_LATER: ReadonlySet<string> = new Set([
  'NotificationRecipient',
  'PaymentReconciliationCase',
  'PaymentReconciliationEvent',
  'OrderClosure',
  'OrderRefundObligation',
  'TenantBillingContact',
  'LocationOpeningPeriod',
  'CheckoutSnapshot',
  'CheckoutSession',
  'FinancialHold',
  'TenantPaymentAccount',
  'PaymentReconciliationNote',
  'PaymentRefund',
  'PaymentRefundEvent',
  'TaxClass',
  'LocationTaxVersion',
  'LocationTaxComponent',
  'LocationTaxComponentClass',
  'OrderTaxSnapshot',
  'OrderTaxRefund',
  'OrderTaxRefundLine',
  'OrderTaxRefundComponent',
]);

// The relationship inventory as it applied to a database from BEFORE the models
// above existed: for historical-state suites that run the integrity checker
// against a scratch database migrated only up to an older migration. A
// polymorphic reference keeps every target type that existed then and loses
// only the types naming a later model (V1 Sales Tax PR 1: the tax_class audit
// target) — no row of such a type can exist before its table did.
export const TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS: readonly TenantRelationship[] =
  TENANT_RELATIONSHIPS.filter(
    (relationship) =>
      !MODELS_ADDED_LATER.has(relationship.model) &&
      !(
        'target' in relationship && MODELS_ADDED_LATER.has(relationship.target)
      ),
  ).map((relationship) =>
    relationship.kind === 'polymorphic'
      ? {
          ...relationship,
          targets: Object.fromEntries(
            Object.entries(relationship.targets).filter(
              ([, model]) => !MODELS_ADDED_LATER.has(model),
            ),
          ),
        }
      : relationship,
  );
