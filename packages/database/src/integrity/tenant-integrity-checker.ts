import {
  TENANT_MODEL_KEYS,
  TENANT_RELATIONSHIPS,
  type DirectReference,
  type JsonReference,
  type PolymorphicReference,
  type RelationshipKind,
  type TenantOwnedModel,
  type TenantRelationship,
} from './relationship-inventory';

// Security 4C-1 — READ-ONLY tenant relationship integrity checker.
//
// For every relationship in the inventory it counts rows whose reference
// resolves to ANOTHER business's record (cross-tenant), resolves to nothing
// (missing target), is absent although required, or contradicts its type
// (polymorphic scope rules). It never writes: all queries run inside one
// `READ ONLY` transaction (a consistent snapshot) that is always rolled
// back, so it needs nothing beyond SELECT privileges.
//
// Findings carry counts and, optionally, the primary-key values of a few
// offending rows — never row contents, names, emails, codes or amounts.
// Table and column names come only from the checked-in inventory and are
// validated before being quoted; all values are bound parameters.

export interface IntegrityQueryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export type FindingType =
  | 'cross-tenant'
  | 'missing-target'
  | 'missing-required'
  | 'invalid-reference'
  | 'unresolved-type';

export interface RelationshipFinding {
  readonly relationshipId: string;
  readonly kind: RelationshipKind;
  readonly type: FindingType;
  readonly severity: 'violation' | 'warning';
  readonly count: number;
  // e.g. the polymorphic type value or JSON path the finding is about.
  readonly detail?: string;
  // Primary-key values of up to `sampleLimit` offending rows.
  readonly sampleKeys: readonly string[];
}

export interface KindSummary {
  relationships: number;
  checked: number;
  violations: number;
  warnings: number;
}

export interface TenantIntegrityReport {
  readonly relationshipsChecked: number;
  readonly violations: number;
  readonly warnings: number;
  readonly byKind: Readonly<Record<RelationshipKind, KindSummary>>;
  readonly findings: readonly RelationshipFinding[];
  // Relationships the checker cannot verify, with the reason.
  readonly notCheckable: ReadonlyArray<{ id: string; reason: string }>;
}

export interface TenantIntegrityOptions {
  // Offending primary keys to include per finding (default 5, max 50).
  sampleLimit?: number;
  relationships?: readonly TenantRelationship[];
  // Per-statement timeout inside the read-only transaction.
  statementTimeoutMs?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe identifier in the relationship inventory: ${name}`);
  }
  return `"${name}"`;
}

function keyExpression(model: TenantOwnedModel): string {
  const keys = TENANT_MODEL_KEYS[model];
  return keys.length === 1
    ? `c.${ident(keys[0])}::text`
    : `concat_ws(':', ${keys.map((k) => `c.${ident(k)}::text`).join(', ')})`;
}

interface JoinCheck {
  relationship: TenantRelationship;
  model: TenantOwnedModel;
  target: TenantOwnedModel;
  // SQL for the referenced id, in terms of alias `c`.
  reference: string;
  // Extra AND-condition (e.g. a polymorphic type) and its parameters.
  condition?: string;
  params: unknown[];
  missingSeverity: 'violation' | 'warning';
  detail?: string;
}

export async function checkTenantIntegrity(
  client: IntegrityQueryable,
  options: TenantIntegrityOptions = {},
): Promise<TenantIntegrityReport> {
  const relationships = options.relationships ?? TENANT_RELATIONSHIPS;
  const sampleLimit = Math.min(Math.max(options.sampleLimit ?? 5, 0), 50);
  const timeout = Math.max(1, Math.floor(options.statementTimeoutMs ?? 60_000));

  const findings: RelationshipFinding[] = [];
  const notCheckable: Array<{ id: string; reason: string }> = [];
  const byKind = {} as Record<RelationshipKind, KindSummary>;
  for (const kind of [
    'composite-fk-candidate',
    'historical-snapshot',
    'polymorphic',
    'json-reference',
    'external-identifier',
  ] as const) {
    byKind[kind] = { relationships: 0, checked: 0, violations: 0, warnings: 0 };
  }

  const record = (finding: RelationshipFinding) => {
    if (finding.count === 0) return;
    findings.push(finding);
    const summary = byKind[finding.kind];
    if (finding.severity === 'violation') summary.violations += finding.count;
    else summary.warnings += finding.count;
  };

  const samples = async (
    from: string,
    where: string,
    params: unknown[],
    model: TenantOwnedModel,
  ): Promise<string[]> => {
    if (sampleLimit === 0) return [];
    const { rows } = await client.query<{ key: string }>(
      `SELECT ${keyExpression(model)} AS key ${from} WHERE ${where}
        ORDER BY 1 LIMIT ${sampleLimit}`,
      params,
    );
    return rows.map((row) => row.key);
  };

  const runJoinCheck = async (check: JoinCheck) => {
    const from = `FROM ${ident(check.model)} c
      LEFT JOIN ${ident(check.target)} p ON p."id" = (${check.reference})`;
    const base = `(${check.reference}) IS NOT NULL${
      check.condition ? ` AND ${check.condition}` : ''
    }`;
    const crossWhere = `${base} AND p."id" IS NOT NULL AND p."tenantId" <> c."tenantId"`;
    const missingWhere = `${base} AND p."id" IS NULL`;
    const { rows } = await client.query<{
      cross_tenant: number;
      missing: number;
    }>(
      `SELECT count(*) FILTER (WHERE ${crossWhere})::int AS cross_tenant,
              count(*) FILTER (WHERE ${missingWhere})::int AS missing
         ${from} WHERE ${base}`,
      check.params,
    );
    const cross = rows[0]?.cross_tenant ?? 0;
    const missing = rows[0]?.missing ?? 0;
    const kind = check.relationship.kind;
    if (cross > 0) {
      record({
        relationshipId: check.relationship.id,
        kind,
        type: 'cross-tenant',
        severity: 'violation',
        count: cross,
        detail: check.detail,
        sampleKeys: await samples(from, crossWhere, check.params, check.model),
      });
    }
    if (missing > 0) {
      record({
        relationshipId: check.relationship.id,
        kind,
        type: 'missing-target',
        severity: check.missingSeverity,
        count: missing,
        detail: check.detail,
        sampleKeys: await samples(
          from,
          missingWhere,
          check.params,
          check.model,
        ),
      });
    }
  };

  const countWhere = async (
    relationship: TenantRelationship,
    where: string,
    params: unknown[],
    type: FindingType,
    severity: 'violation' | 'warning',
    detail?: string,
  ) => {
    const from = `FROM ${ident(relationship.model)} c`;
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n ${from} WHERE ${where}`,
      params,
    );
    const count = rows[0]?.n ?? 0;
    if (count > 0) {
      record({
        relationshipId: relationship.id,
        kind: relationship.kind,
        type,
        severity,
        count,
        detail,
        sampleKeys: await samples(from, where, params, relationship.model),
      });
    }
  };

  const checkDirect = async (relationship: DirectReference) => {
    const column = `c.${ident(relationship.column)}`;
    if (!relationship.nullable) {
      // An empty string is as absent as NULL for a plain (non-FK) column.
      await countWhere(
        relationship,
        relationship.hasForeignKey
          ? `${column} IS NULL`
          : `(${column} IS NULL OR ${column} = '')`,
        [],
        'missing-required',
        'violation',
      );
    }
    await runJoinCheck({
      relationship,
      model: relationship.model,
      target: relationship.target,
      reference: relationship.hasForeignKey ? column : `NULLIF(${column}, '')`,
      params: [],
      missingSeverity:
        relationship.kind === 'historical-snapshot' ? 'warning' : 'violation',
    });
  };

  const checkPolymorphic = async (relationship: PolymorphicReference) => {
    const column = `c.${ident(relationship.column)}`;
    const type = `c.${ident(relationship.typeColumn)}::text`;
    for (const [value, target] of Object.entries(relationship.targets)) {
      await runJoinCheck({
        relationship,
        model: relationship.model,
        target,
        reference: `NULLIF(${column}, '')`,
        condition: `${type} = $1`,
        params: [value],
        missingSeverity: relationship.missingTarget,
        detail: value,
      });
    }
    for (const value of relationship.nullForTypes ?? []) {
      await countWhere(
        relationship,
        `${type} = $1 AND ${column} IS NOT NULL`,
        [value],
        'invalid-reference',
        'violation',
        `${value} must not carry an id`,
      );
    }
    for (const value of relationship.requiredForTypes ?? []) {
      await countWhere(
        relationship,
        `${type} = $1 AND (${column} IS NULL OR ${column} = '')`,
        [value],
        'missing-required',
        'violation',
        `${value} requires an id`,
      );
    }
    const known = [
      ...Object.keys(relationship.targets),
      ...relationship.nonRecordTypes,
      ...(relationship.nullForTypes ?? []),
    ];
    const { rows } = await client.query<{ value: string; n: number }>(
      `SELECT ${type} AS value, count(*)::int AS n FROM ${ident(relationship.model)} c
        WHERE NOT (${type} = ANY($1::text[]))
        GROUP BY 1 ORDER BY 1 LIMIT 20`,
      [known],
    );
    for (const row of rows) {
      // Type values are code-defined labels, never customer data.
      record({
        relationshipId: relationship.id,
        kind: relationship.kind,
        type: 'unresolved-type',
        severity: 'warning',
        count: row.n,
        detail: row.value,
        sampleKeys: [],
      });
    }
  };

  const checkJson = async (relationship: JsonReference) => {
    for (const { path, target } of relationship.paths) {
      for (const segment of path) ident(segment);
      await runJoinCheck({
        relationship,
        model: relationship.model,
        target,
        reference: `NULLIF(c.${ident(relationship.column)} #>> $1::text[], '')`,
        params: [path],
        missingSeverity: 'violation',
        detail: path.join('.'),
      });
    }
  };

  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    for (const relationship of relationships) {
      byKind[relationship.kind].relationships += 1;
      switch (relationship.kind) {
        case 'composite-fk-candidate':
        case 'historical-snapshot':
          await checkDirect(relationship);
          break;
        case 'polymorphic':
          await checkPolymorphic(relationship);
          break;
        case 'json-reference':
          if (relationship.paths.length === 0) {
            notCheckable.push({
              id: relationship.id,
              reason: 'snapshot JSON with no live references',
            });
            continue;
          }
          await checkJson(relationship);
          break;
        case 'external-identifier':
          notCheckable.push({
            id: relationship.id,
            reason: `issued by an external system (${relationship.system})`,
          });
          continue;
      }
      byKind[relationship.kind].checked += 1;
    }
  } finally {
    await client.query('ROLLBACK');
  }

  const total = (severity: 'violation' | 'warning') =>
    findings
      .filter((f) => f.severity === severity)
      .reduce((sum, f) => sum + f.count, 0);
  return {
    relationshipsChecked: Object.values(byKind).reduce(
      (sum, s) => sum + s.checked,
      0,
    ),
    violations: total('violation'),
    warnings: total('warning'),
    byKind,
    findings,
    notCheckable,
  };
}

export function formatTenantIntegrityReport(
  report: TenantIntegrityReport,
): string {
  const lines = [
    `Tenant relationship integrity: ${report.relationshipsChecked} relationships checked, ` +
      `${report.violations} violation(s), ${report.warnings} warning(s).`,
    '',
    'By relationship type:',
  ];
  for (const [kind, s] of Object.entries(report.byKind)) {
    lines.push(
      `  ${kind.padEnd(24)} ${String(s.checked).padStart(3)}/${String(
        s.relationships,
      ).padEnd(
        3,
      )} checked  ${s.violations} violation(s)  ${s.warnings} warning(s)`,
    );
  }
  if (report.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const f of report.findings) {
      lines.push(
        `  [${f.severity}] ${f.relationshipId} ${f.type}${
          f.detail ? ` (${f.detail})` : ''
        }: ${f.count}${
          f.sampleKeys.length > 0 ? `  e.g. ${f.sampleKeys.join(', ')}` : ''
        }`,
      );
    }
  }
  if (report.notCheckable.length > 0) {
    lines.push('', 'Not checkable:');
    for (const n of report.notCheckable) {
      lines.push(`  ${n.id}: ${n.reason}`);
    }
  }
  return lines.join('\n');
}
