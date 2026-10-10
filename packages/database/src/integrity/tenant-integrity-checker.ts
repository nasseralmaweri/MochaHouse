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
// (missing target), is absent although required, carries an id its type
// does not allow, or has a type the inventory cannot resolve. It never
// writes: all queries run inside one `READ ONLY` transaction (a consistent
// snapshot) that is always rolled back, so it needs nothing beyond SELECT
// privileges. It never repairs or deletes anything.
//
// Severity rules:
//   - a reference that resolves to another business is ALWAYS a violation,
//     for live and historical rows alike;
//   - a missing target is a violation for live references, and a warning
//     only for history (snapshots, audit entries, processed / failed
//     events) — but a row still being acted on (e.g. a PENDING outbox
//     event) with a missing target is a violation;
//   - a polymorphic type the inventory cannot resolve is a violation (its
//     target cannot be checked at all) and is also listed under
//     `notCheckable` with its row count.
//
// The report's `verdict` is 'clean' only with zero violations AND zero rows
// that could not be evaluated; documented by-design exclusions (snapshot
// JSON, external ids) are listed but never hide data.
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

export interface NotCheckableEntry {
  readonly id: string;
  readonly reason: string;
  // Rows that could not be evaluated; null for a by-design exclusion that
  // holds no live references at all.
  readonly rows: number | null;
}

export type IntegrityVerdict = 'clean' | 'violations' | 'incomplete';

export interface TenantIntegrityReport {
  // 'clean' only when there are no violations and no unevaluated rows.
  readonly verdict: IntegrityVerdict;
  readonly relationshipsChecked: number;
  readonly violations: number;
  readonly warnings: number;
  // Rows that exist but could not be evaluated (never counted as clean).
  readonly uncheckedRows: number;
  readonly byKind: Readonly<Record<RelationshipKind, KindSummary>>;
  readonly findings: readonly RelationshipFinding[];
  readonly notCheckable: readonly NotCheckableEntry[];
}

export interface TenantIntegrityOptions {
  // Offending primary keys to include per finding (default 5, max 50).
  sampleLimit?: number;
  relationships?: readonly TenantRelationship[];
  // Per-statement timeout inside the read-only transaction.
  statementTimeoutMs?: number;
}

export function integrityVerdict(
  violations: number,
  uncheckedRows: number,
): IntegrityVerdict {
  if (violations > 0) return 'violations';
  if (uncheckedRows > 0) return 'incomplete';
  return 'clean';
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

interface ReferenceCheck {
  relationship: TenantRelationship;
  model: TenantOwnedModel;
  target: TenantOwnedModel;
  // The target column the reference names (`id`, or a per-business key).
  targetColumn: string;
  // SQL for the referenced value, in terms of alias `c`.
  reference: string;
  // Extra AND-condition (e.g. a polymorphic type) and its parameters.
  condition?: string;
  params: unknown[];
  missingSeverity: 'violation' | 'warning';
  // SQL condition (alias `c`) marking rows still being acted on, whose
  // missing target is always a violation.
  active?: string;
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
  const notCheckable: NotCheckableEntry[] = [];
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

  // Resolves each reference against the target table by EXISTS: one row of
  // the SAME business means the reference is sound; otherwise a row of
  // another business makes it cross-tenant, and no row at all makes it
  // missing. (For record ids, which are globally unique, this is the same as
  // a join; for per-business keys it is the only correct reading.)
  const checkReferences = async (check: ReferenceCheck) => {
    const target = ident(check.target);
    const column = ident(check.targetColumn);
    const same = `EXISTS (SELECT 1 FROM ${target} p WHERE p.${column}::text = (${check.reference}) AND p."tenantId" = c."tenantId")`;
    const other = `EXISTS (SELECT 1 FROM ${target} p WHERE p.${column}::text = (${check.reference}) AND p."tenantId" <> c."tenantId")`;
    const from = `FROM ${ident(check.model)} c`;
    const base = `(${check.reference}) IS NOT NULL${
      check.condition ? ` AND ${check.condition}` : ''
    }`;
    const crossWhere = `${base} AND NOT ${same} AND ${other}`;
    const missingWhere = `${base} AND NOT ${same} AND NOT ${other}`;
    const active = check.active ?? 'false';
    const missingActiveWhere = `${missingWhere} AND (${active})`;
    const missingOtherWhere = `${missingWhere} AND NOT (${active})`;
    const { rows } = await client.query<{
      cross_tenant: number;
      missing_active: number;
      missing_other: number;
    }>(
      `SELECT count(*) FILTER (WHERE ${crossWhere})::int AS cross_tenant,
              count(*) FILTER (WHERE ${missingActiveWhere})::int AS missing_active,
              count(*) FILTER (WHERE ${missingOtherWhere})::int AS missing_other
         ${from} WHERE ${base}`,
      check.params,
    );
    const counts = rows[0] ?? {
      cross_tenant: 0,
      missing_active: 0,
      missing_other: 0,
    };
    const kind = check.relationship.kind;
    const emit = async (
      count: number,
      type: FindingType,
      severity: 'violation' | 'warning',
      where: string,
      detail?: string,
    ) => {
      if (count === 0) return;
      record({
        relationshipId: check.relationship.id,
        kind,
        type,
        severity,
        count,
        detail,
        sampleKeys: await samples(from, where, check.params, check.model),
      });
    };
    await emit(
      counts.cross_tenant,
      'cross-tenant',
      'violation',
      crossWhere,
      check.detail,
    );
    await emit(
      counts.missing_active,
      'missing-target',
      'violation',
      missingActiveWhere,
      [check.detail, 'still active'].filter(Boolean).join(', '),
    );
    await emit(
      counts.missing_other,
      'missing-target',
      check.missingSeverity,
      missingOtherWhere,
      check.detail,
    );
  };

  const countWhere = async (
    relationship: TenantRelationship,
    where: string,
    params: unknown[],
    type: FindingType,
    severity: 'violation' | 'warning',
    detail?: string,
  ): Promise<number> => {
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
    return count;
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
    await checkReferences({
      relationship,
      model: relationship.model,
      target: relationship.target,
      targetColumn: 'id',
      reference: relationship.hasForeignKey ? column : `NULLIF(${column}, '')`,
      params: [],
      missingSeverity:
        relationship.kind === 'historical-snapshot' ? 'warning' : 'violation',
    });
  };

  const checkPolymorphic = async (relationship: PolymorphicReference) => {
    const column = `c.${ident(relationship.column)}`;
    const type = `c.${ident(relationship.typeColumn)}::text`;
    // Status labels are code-defined enum values; validated, then inlined.
    const active = relationship.activeWhen
      ? `c.${ident(relationship.activeWhen.column)}::text IN (${relationship.activeWhen.values
          .map((v) => `'${ident(v).slice(1, -1)}'`)
          .join(', ')})`
      : undefined;
    const resolve = async (
      value: string,
      target: TenantOwnedModel,
      targetColumn: string,
    ) =>
      checkReferences({
        relationship,
        model: relationship.model,
        target,
        targetColumn,
        reference: `NULLIF(${column}, '')`,
        condition: `${type} = $1`,
        params: [value],
        missingSeverity: relationship.missingTarget,
        active,
        detail: value,
      });
    for (const [value, target] of Object.entries(relationship.targets)) {
      await resolve(value, target, 'id');
    }
    for (const [value, key] of Object.entries(
      relationship.keyedTargets ?? {},
    )) {
      await resolve(value, key.model, key.column);
    }
    for (const [value, fixed] of Object.entries(
      relationship.fixedTargets ?? {},
    )) {
      await countWhere(
        relationship,
        `${type} = $1 AND ${column} IS DISTINCT FROM $2`,
        [value, fixed],
        'invalid-reference',
        'violation',
        `${value} must name '${fixed}'`,
      );
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
      ...Object.keys(relationship.keyedTargets ?? {}),
      ...Object.keys(relationship.fixedTargets ?? {}),
      ...(relationship.nullForTypes ?? []),
    ];
    const unknownWhere = `${type} IS NULL OR NOT (${type} = ANY($1::text[]))`;
    const { rows } = await client.query<{ value: string | null; n: number }>(
      `SELECT ${type} AS value, count(*)::int AS n FROM ${ident(relationship.model)} c
        WHERE ${unknownWhere} GROUP BY 1 ORDER BY 1`,
      [known],
    );
    for (const row of rows) {
      // Type values are code-defined labels, never customer data.
      const label = row.value ?? '(null)';
      record({
        relationshipId: relationship.id,
        kind: relationship.kind,
        type: 'unresolved-type',
        severity: 'violation',
        count: row.n,
        detail: label,
        sampleKeys: await samples(
          `FROM ${ident(relationship.model)} c`,
          row.value === null ? `${type} IS NULL` : `${type} = $1`,
          row.value === null ? [] : [row.value],
          relationship.model,
        ),
      });
      notCheckable.push({
        id: relationship.id,
        reason: `unknown ${relationship.typeColumn} "${label}": its target cannot be resolved, so cross-business links cannot be ruled out`,
        rows: row.n,
      });
    }
  };

  const checkJson = async (relationship: JsonReference) => {
    for (const { path, target } of relationship.paths) {
      for (const segment of path) ident(segment);
      await checkReferences({
        relationship,
        model: relationship.model,
        target,
        targetColumn: 'id',
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
              reason: 'by design: snapshot JSON with no live references',
              rows: null,
            });
            continue;
          }
          await checkJson(relationship);
          break;
        case 'external-identifier':
          notCheckable.push({
            id: relationship.id,
            reason: `by design: issued by an external system (${relationship.system})`,
            rows: null,
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
  const violations = total('violation');
  const uncheckedRows = notCheckable.reduce((sum, n) => sum + (n.rows ?? 0), 0);
  return {
    verdict: integrityVerdict(violations, uncheckedRows),
    relationshipsChecked: Object.values(byKind).reduce(
      (sum, s) => sum + s.checked,
      0,
    ),
    violations,
    warnings: total('warning'),
    uncheckedRows,
    byKind,
    findings,
    notCheckable,
  };
}

export function formatTenantIntegrityReport(
  report: TenantIntegrityReport,
): string {
  const lines = [
    `Verdict: ${report.verdict.toUpperCase()}`,
    `Tenant relationship integrity: ${report.relationshipsChecked} relationships checked, ` +
      `${report.violations} violation(s), ${report.warnings} warning(s), ` +
      `${report.uncheckedRows} row(s) not checkable.`,
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
      lines.push(
        `  ${n.id}: ${n.reason}${n.rows === null ? '' : ` — ${n.rows} row(s)`}`,
      );
    }
  }
  return lines.join('\n');
}
