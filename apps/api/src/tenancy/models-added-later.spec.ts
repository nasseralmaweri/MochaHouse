import {
  TENANT_RELATIONSHIPS,
  type PolymorphicReference,
} from '@mocha-house/database';
import {
  MODELS_ADDED_LATER,
  TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS,
} from './models-added-later';

// The inventory used to check databases migrated only up to an older
// migration must name no table that did not exist yet — including through a
// polymorphic target type (V1 Sales Tax PR 1 added the tax_class audit
// target) — while keeping every other relationship and target unchanged.
describe('relationship inventory before later models', () => {
  const polymorphic = (list: readonly unknown[], id: string) =>
    list.find(
      (r) => (r as PolymorphicReference).id === id,
    ) as PolymorphicReference;

  it('names no later model, directly or as a polymorphic target', () => {
    for (const relationship of TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS) {
      expect(MODELS_ADDED_LATER.has(relationship.model)).toBe(false);
      if ('target' in relationship) {
        expect(MODELS_ADDED_LATER.has(relationship.target)).toBe(false);
      }
      if (relationship.kind === 'polymorphic') {
        for (const model of Object.values(relationship.targets)) {
          expect(MODELS_ADDED_LATER.has(model)).toBe(false);
        }
      }
    }
  });

  it('drops only the tax_class audit target; every other audit target and setting is kept', () => {
    const now = polymorphic(
      TENANT_RELATIONSHIPS,
      'InternalAuditEvent.targetId',
    );
    const before = polymorphic(
      TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS,
      'InternalAuditEvent.targetId',
    );
    const { tax_class: dropped, ...kept } = now.targets as Record<
      string,
      string
    >;
    expect(dropped).toBe('TaxClass');
    expect(before.targets).toEqual(kept);
    expect(before.keyedTargets).toEqual(now.keyedTargets);
    expect(before.fixedTargets).toEqual(now.fixedTargets);
    expect(before.missingTarget).toBe(now.missingTarget);
  });

  it('keeps every relationship that does not involve a later model', () => {
    const kept = TENANT_RELATIONSHIPS.filter(
      (r) =>
        !MODELS_ADDED_LATER.has(r.model) &&
        !('target' in r && MODELS_ADDED_LATER.has(r.target)),
    ).map((r) => r.id);
    expect(TENANT_RELATIONSHIPS_BEFORE_LATER_MODELS.map((r) => r.id)).toEqual(
      kept,
    );
  });
});
