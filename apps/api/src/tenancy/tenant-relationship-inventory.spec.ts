import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_TENANCY,
  TENANT_MODEL_KEYS,
  TENANT_RELATIONSHIPS,
  type DirectReference,
  type PolymorphicReference,
  type TenantRelationship,
} from '@mocha-house/database';

// Security 4C-1 — the tenant relationship inventory is complete and exact.
//
// This spec re-derives every reference between business-owned records from
// schema.prisma itself — foreign-key relations, plain `...Id` columns and
// JSON columns — and fails when one exists without a classification in
// relationship-inventory.ts, when a classified one no longer exists, or
// when its target, nullability or delete rule has changed. It also fails
// when application code starts using a polymorphic type value the
// inventory cannot resolve.

const repoRoot = join(__dirname, '../../../..');
const schema = readFileSync(
  join(repoRoot, 'packages/database/prisma/schema.prisma'),
  'utf8',
);

interface Field {
  name: string;
  type: string; // without ? / []
  optional: boolean;
  list: boolean;
  attributes: string;
}
interface Relation {
  model: string;
  field: string;
  fields: string[];
  references: string[];
  target: string;
  optional: boolean;
  onDelete?: string;
}
interface Model {
  name: string;
  fields: Map<string, Field>;
  relations: Relation[];
  primaryKey: string[];
  body: string;
}

function parseSchema(source: string): Map<string, Model> {
  const models = new Map<string, Model>();
  for (const match of source.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const model: Model = {
      name: match[1],
      fields: new Map(),
      relations: [],
      primaryKey: [],
      body: match[2],
    };
    for (const rawLine of match[2].split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const compositeId = /^@@id\(\[([^\]]+)\]/.exec(line);
      if (compositeId) {
        model.primaryKey = compositeId[1].split(',').map((s) => s.trim());
        continue;
      }
      if (line.startsWith('@@')) continue;
      const parts = /^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/.exec(line);
      if (!parts)
        throw new Error(`Unparsed line in model ${model.name}: ${line}`);
      const field: Field = {
        name: parts[1],
        type: parts[2],
        optional: parts[3] === '?',
        list: parts[3] === '[]',
        attributes: parts[4],
      };
      model.fields.set(field.name, field);
      if (/@id\b/.test(field.attributes)) model.primaryKey = [field.name];
      const relation = /@relation\(([^)]*)\)/.exec(field.attributes);
      if (relation && relation[1].includes('fields:')) {
        const list = (key: string) =>
          new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`)
            .exec(relation[1])![1]
            .split(',')
            .map((s) => s.trim());
        model.relations.push({
          model: model.name,
          field: field.name,
          fields: list('fields'),
          references: list('references'),
          target: field.type,
          optional: field.optional,
          onDelete: /onDelete:\s*(\w+)/.exec(relation[1])?.[1],
        });
      }
    }
    models.set(model.name, model);
  }
  return models;
}

const models = parseSchema(schema);
const tenantModels = [...models.values()].filter((m) =>
  m.fields.has('tenantId'),
);
const byId = new Map(TENANT_RELATIONSHIPS.map((r) => [r.id, r]));

const relationsBetweenBusinessRecords = tenantModels.flatMap((m) =>
  m.relations.filter((r) => r.target !== 'Tenant'),
);
// The column a relation references through: a plain single-column foreign
// key ([col] -> [id]) or, since Security 4C-3, a tenant-enforced composite one
// ([tenantId, col] -> [tenantId, id]). Anything else is unsupported (null).
const referencingColumn = (r: Relation): string | null => {
  if (r.fields.length === 1 && r.references.join() === 'id') return r.fields[0];
  if (
    r.fields.length === 2 &&
    r.fields[0] === 'tenantId' &&
    r.references.join() === 'tenantId,id'
  ) {
    return r.fields[1];
  }
  return null;
};
const isTenantEnforced = (r: Relation) => r.fields.length === 2;
const relationColumns = (m: Model) =>
  new Set(m.relations.flatMap((r) => r.fields));
const plainIdColumns = tenantModels.flatMap((m) =>
  [...m.fields.values()]
    .filter(
      (f) =>
        f.type === 'String' &&
        /Id$/.test(f.name) &&
        f.name !== 'tenantId' &&
        !relationColumns(m).has(f.name),
    )
    .map((f) => ({ model: m, field: f })),
);
const jsonColumns = tenantModels.flatMap((m) =>
  [...m.fields.values()]
    .filter((f) => f.type === 'Json')
    .map((f) => ({ model: m, field: f })),
);

const effectiveOnDelete = (r: Relation) =>
  r.onDelete ?? (r.optional ? 'SetNull' : 'Restrict');

describe('Tenant relationship inventory (Security 4C-1)', () => {
  it('parses every relation and model in schema.prisma (no silent omissions)', () => {
    const declared = (schema.match(/@relation\([^)]*fields:/g) ?? []).length;
    const parsed = [...models.values()].reduce(
      (n, m) => n + m.relations.length,
      0,
    );
    expect(parsed).toBe(declared);
    expect(models.size).toBe((schema.match(/^model \w+ \{/gm) ?? []).length);
    // Every business-owned model is exactly the tenant set MODEL_TENANCY
    // declares, and each has exactly one relation to its Tenant.
    expect(tenantModels.map((m) => m.name).sort()).toEqual(
      Object.entries(MODEL_TENANCY)
        .filter(([, tenancy]) => tenancy === 'tenant')
        .map(([name]) => name)
        .sort(),
    );
    for (const m of tenantModels) {
      expect(
        m.relations
          .filter((r) => r.target === 'Tenant')
          .map((r) => r.fields.join(',')),
      ).toEqual(['tenantId']);
    }
  });

  it('every relation is a single-column or a (tenantId, column) composite foreign key', () => {
    expect(
      relationsBetweenBusinessRecords.filter(
        (r) => referencingColumn(r) === null,
      ),
    ).toEqual([]);
  });

  it('classifies every foreign-key relation between business-owned records as a composite foreign-key candidate', () => {
    const unclassified: string[] = [];
    const mismatched: string[] = [];
    for (const r of relationsBetweenBusinessRecords) {
      const id = `${r.model}.${referencingColumn(r)}`;
      const entry = byId.get(id) as DirectReference | undefined;
      if (!entry) {
        unclassified.push(id);
        continue;
      }
      const expected = {
        kind: 'composite-fk-candidate',
        target: r.target,
        nullable: r.optional,
        hasForeignKey: true,
        onDelete: effectiveOnDelete(r),
        tenantEnforced: isTenantEnforced(r) || undefined,
      };
      const actual = {
        kind: entry.kind,
        target: entry.target,
        nullable: entry.nullable,
        hasForeignKey: entry.hasForeignKey,
        onDelete: entry.onDelete,
        tenantEnforced: entry.tenantEnforced,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatched.push(`${id}: ${JSON.stringify({ expected, actual })}`);
      }
    }
    expect({ unclassified, mismatched }).toEqual({
      unclassified: [],
      mismatched: [],
    });
    expect(relationsBetweenBusinessRecords).toHaveLength(83);
    // Security 4C-3: customers, orders and payments are tenant-enforced.
    expect(
      relationsBetweenBusinessRecords
        .filter(isTenantEnforced)
        .map((r) => `${r.model}.${referencingColumn(r)}`)
        .sort(),
    ).toEqual([
      'CustomerNote.customerId',
      'CustomerPreferredLocation.customerId',
      'CustomerPreferredLocation.locationId',
      'Order.customerId',
      'Order.locationId',
      'Order.paymentAttemptId',
      'OrderLine.orderId',
      'OrderStatusHistory.orderId',
      'PaymentAttempt.locationId',
    ]);
  });

  it('classifies every plain id column (no foreign key) on business-owned records', () => {
    const unclassified: string[] = [];
    const mismatched: string[] = [];
    for (const { model, field } of plainIdColumns) {
      const id = `${model.name}.${field.name}`;
      const entry = byId.get(id);
      if (!entry) {
        unclassified.push(id);
        continue;
      }
      if (entry.nullable !== field.optional) mismatched.push(`${id}: nullable`);
      if (
        (entry.kind === 'composite-fk-candidate' ||
          entry.kind === 'historical-snapshot') &&
        entry.hasForeignKey
      ) {
        mismatched.push(`${id}: has no foreign key in the schema`);
      }
      if (entry.kind === 'json-reference') mismatched.push(`${id}: not JSON`);
    }
    expect({ unclassified, mismatched }).toEqual({
      unclassified: [],
      mismatched: [],
    });
    expect(plainIdColumns).toHaveLength(16);
  });

  it('classifies every JSON column on business-owned records', () => {
    const unclassified = jsonColumns
      .map(({ model, field }) => ({
        id: `${model.name}.${field.name}`,
        optional: field.optional,
      }))
      .filter(
        ({ id, optional }) =>
          byId.get(id)?.kind !== 'json-reference' ||
          byId.get(id)?.nullable !== optional,
      );
    expect(unclassified).toEqual([]);
    expect(jsonColumns).toHaveLength(6);
  });

  it('has no stale entry: every classified relationship exists in the schema exactly as described', () => {
    const stale: string[] = [];
    for (const entry of TENANT_RELATIONSHIPS) {
      const model = models.get(entry.model);
      const field = model?.fields.get(entry.column);
      if (!model || !field) {
        stale.push(`${entry.id}: column not found`);
        continue;
      }
      if (entry.id !== `${entry.model}.${entry.column}`) {
        stale.push(`${entry.id}: id does not match model.column`);
      }
      if (field.optional !== entry.nullable) {
        stale.push(`${entry.id}: nullable`);
      }
      const targets: string[] =
        entry.kind === 'polymorphic'
          ? Object.values(entry.targets)
          : entry.kind === 'json-reference'
            ? entry.paths.map((p) => p.target)
            : entry.kind === 'external-identifier'
              ? []
              : [entry.target];
      for (const target of targets) {
        if (MODEL_TENANCY[target as keyof typeof MODEL_TENANCY] !== 'tenant') {
          stale.push(`${entry.id}: target ${target} is not business-owned`);
        }
      }
      if (entry.kind === 'polymorphic') {
        for (const [type, key] of Object.entries(entry.keyedTargets ?? {})) {
          if (MODEL_TENANCY[key.model] !== 'tenant') {
            stale.push(
              `${entry.id}: keyed target ${key.model} is not business-owned`,
            );
          }
          if (!models.get(key.model)?.fields.has(key.column)) {
            stale.push(
              `${entry.id}: ${type} key ${key.model}.${key.column} not found`,
            );
          }
          // The key must identify one record per business.
          if (
            !models
              .get(key.model)
              ?.body.includes(`@@unique([tenantId, ${key.column}])`)
          ) {
            stale.push(
              `${entry.id}: ${key.model}.${key.column} is not unique per business`,
            );
          }
        }
        if (entry.activeWhen && !model.fields.has(entry.activeWhen.column)) {
          stale.push(
            `${entry.id}: active column ${entry.activeWhen.column} not found`,
          );
        }
      }
      if (entry.kind === 'polymorphic' && !model.fields.has(entry.typeColumn)) {
        stale.push(`${entry.id}: type column ${entry.typeColumn} not found`);
      }
    }
    expect(stale).toEqual([]);
    expect(new Set(TENANT_RELATIONSHIPS.map((r) => r.id)).size).toBe(
      TENANT_RELATIONSHIPS.length,
    );
  });

  it('reports exact coverage counts by relationship type, including optional references', () => {
    const count = (fn: (r: TenantRelationship) => boolean) =>
      TENANT_RELATIONSHIPS.filter(fn).length;
    expect({
      compositeWithForeignKey: count(
        (r) => r.kind === 'composite-fk-candidate' && r.hasForeignKey,
      ),
      compositeWithoutForeignKey: count(
        (r) => r.kind === 'composite-fk-candidate' && !r.hasForeignKey,
      ),
      historicalSnapshot: count((r) => r.kind === 'historical-snapshot'),
      polymorphic: count((r) => r.kind === 'polymorphic'),
      json: count((r) => r.kind === 'json-reference'),
      external: count((r) => r.kind === 'external-identifier'),
      total: TENANT_RELATIONSHIPS.length,
    }).toEqual({
      compositeWithForeignKey: 83,
      compositeWithoutForeignKey: 2,
      historicalSnapshot: 8,
      polymorphic: 5,
      json: 6,
      external: 1,
      total: 105,
    });
    // Optional relationships are present and marked optional.
    const optionalForeignKeys = relationsBetweenBusinessRecords.filter(
      (r) => r.optional,
    );
    expect(optionalForeignKeys.length).toBeGreaterThan(0);
    for (const r of optionalForeignKeys) {
      expect(byId.get(`${r.model}.${referencingColumn(r)}`)?.nullable).toBe(
        true,
      );
    }
    expect(
      [
        'Order.customerId',
        'MochaBeanLedgerEntry.orderId',
        'GiftCardTransaction.orderId',
        'GiftCardTransaction.giftCardPurchaseId',
        'GiftCardPurchase.customerId',
      ].map((id) => (byId.get(id) as DirectReference).onDelete),
    ).toEqual(['SetNull', 'SetNull', 'SetNull', 'SetNull', 'SetNull']);
  });

  it('records the primary key of every business-owned table', () => {
    expect(
      Object.fromEntries(
        Object.entries(TENANT_MODEL_KEYS).map(([k, v]) => [k, [...v]]),
      ),
    ).toEqual(
      Object.fromEntries(tenantModels.map((m) => [m.name, m.primaryKey])),
    );
  });

  describe('polymorphic type values used by application code', () => {
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
      });
    const code = [
      ...sourceFiles(join(repoRoot, 'apps/api/src')),
      ...sourceFiles(join(repoRoot, 'apps/worker/src')),
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const literals = (key: string) =>
      new Set(
        [...code.matchAll(new RegExp(`${key}:\\s*'([A-Za-z_.]+)'`, 'g'))].map(
          (m) => m[1],
        ),
      );
    const resolvable = (id: string) => {
      const entry = byId.get(id) as PolymorphicReference;
      return new Set([
        ...Object.keys(entry.targets),
        ...Object.keys(entry.keyedTargets ?? {}),
        ...Object.keys(entry.fixedTargets ?? {}),
        ...(entry.nullForTypes ?? []),
      ]);
    };

    it('every audit target type is classified', () => {
      const known = resolvable('InternalAuditEvent.targetId');
      const used = literals('targetType');
      expect(used.size).toBeGreaterThan(10);
      expect([...used].filter((t) => !known.has(t))).toEqual([]);
    });

    it('every outbox / notification aggregate type is classified', () => {
      const used = literals('aggregateType');
      expect(used.size).toBeGreaterThan(0);
      for (const id of [
        'OutboxEvent.aggregateId',
        'NotificationDelivery.aggregateId',
      ]) {
        const known = resolvable(id);
        expect([...used].filter((t) => !known.has(t))).toEqual([]);
      }
    });

    it('every approval target type constant is classified', () => {
      const contracts = readFileSync(
        join(repoRoot, 'packages/contracts/src/index.ts'),
        'utf8',
      );
      const used = [
        ...contracts.matchAll(
          /export const APPROVAL_TARGET_TYPE_\w+\s*=\s*"([^"]+)"/g,
        ),
      ].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(0);
      const known = resolvable('ApprovalRequest.targetId');
      expect(used.filter((t) => !known.has(t))).toEqual([]);
    });

    it('the staff scope types match the InternalScopeType enum', () => {
      const values = /enum InternalScopeType \{([^}]*)\}/
        .exec(schema)![1]
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      expect(
        [...resolvable('InternalUserRoleAssignment.scopeId')].sort(),
      ).toEqual(values);
    });
  });
});
