import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Client } from 'pg';
import {
  PrismaClient,
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_RELATIONSHIPS,
  checkTenantIntegrity,
  type DirectReference,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_C_ID,
  applyMigrations,
  createMigrationProject,
  createScratchDatabase,
  databaseCatalog,
  isAppliedAtomically,
  listMigrations,
  prismaCli,
  withScratchClient,
  type ExtraMigration,
  type MigrationProject,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Security 4C-3 — PostgreSQL-enforced tenant agreement for customer, order
// and payment relationships: nine composite foreign keys
// ("tenantId", <column>) -> parent ("tenantId", "id").
//
// This spec proves, with three fictional businesses (A = Mocha House,
// B and C = test businesses):
//   - schema.prisma, the relationship inventory, the migration and the
//     rollback name exactly the same nine relationships;
//   - the configured (migrated) test database enforces all nine, and a
//     deliberately removed key is detected;
//   - same-business references are accepted, every cross-business reference
//     (every relationship x every ordered pair of businesses, by direct SQL
//     INSERT, UPDATE and by moving either side to another business) is
//     rejected by PostgreSQL itself, and optional references may stay NULL;
//   - deletion behaviour is unchanged (including SET NULL of only
//     Order.customerId), except the intentional new PaymentAttempt.locationId
//     RESTRICT;
//   - no row of the six referencing tables can move to another business
//     (a composite key alone cannot stop a row whose tenantId changes
//     together with its reference — which is what a Prisma nested connect
//     to another business's record does), so such connects are rejected;
//   - rejected writes change nothing, and the integrity checker reports a
//     clean database with zero unchecked rows;
//   - the migration, run by the REAL `prisma migrate deploy`, aborts on any
//     mismatched row before changing anything, never reassigns ownership,
//     is atomic even when it fails at its last statement, fails fast on
//     locks, leaves no drift, and the shipped rollback restores the previous
//     catalog exactly.
// All data is fictional.

jest.setTimeout(600_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const MIGRATION = '20261012090000_tenant_fk_customer_order_payment';
const migrations = listMigrations(migrationsDir);
const targetIndex = migrations.findIndex((m) => m.name === MIGRATION);
const target = migrations[targetIndex];
const rollbackSql = readFileSync(
  join(databaseDir, `prisma/rollbacks/${MIGRATION}.down.sql`),
  'utf8',
);
const schema = readFileSync(join(databaseDir, 'prisma/schema.prisma'), 'utf8');
const baseUrl = process.env.DATABASE_URL!;

type Tag = 'a' | 'b' | 'c';
const TAGS: Tag[] = ['a', 'b', 'c'];
const TENANTS: Record<Tag, string> = {
  a: TENANT_1_MOCHA_HOUSE_ID,
  b: TEST_TENANT_B_ID,
  c: TEST_TENANT_C_ID,
};
const PAIRS: Array<[Tag, Tag]> = TAGS.flatMap((x) =>
  TAGS.filter((y) => y !== x).map((y) => [x, y] as [Tag, Tag]),
);

// Deterministic fictional ids, so two databases hold identical rows.
const id = (tag: Tag, name: string) => `fk-${tag}-${name}`;

interface Relationship {
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly onDelete: 'CASCADE' | 'RESTRICT' | 'SET NULL ("customerId")';
  readonly optional: boolean;
  // The fixture row of the child, and the unused parent of each business it
  // is pointed at (so no other unique constraint can fire first).
  readonly childRow: string;
  readonly spareParent: string;
  // Columns a copied row must change to stay unique.
  readonly uniqueColumns: readonly string[];
}

const RELATIONSHIPS: readonly Relationship[] = [
  {
    child: 'CustomerPreferredLocation',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'pref',
    spareParent: 'customer-spare',
    uniqueColumns: [],
  },
  {
    child: 'CustomerPreferredLocation',
    column: 'locationId',
    parent: 'Location',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'pref',
    spareParent: 'location-spare',
    uniqueColumns: [],
  },
  {
    child: 'CustomerNote',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'note',
    spareParent: 'customer-spare',
    uniqueColumns: [],
  },
  {
    child: 'Order',
    column: 'locationId',
    parent: 'Location',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'order',
    spareParent: 'location-spare',
    uniqueColumns: ['orderNumber', 'accessToken', 'paymentAttemptId'],
  },
  {
    child: 'Order',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'SET NULL ("customerId")',
    optional: true,
    childRow: 'order',
    spareParent: 'customer-spare',
    uniqueColumns: ['orderNumber', 'accessToken', 'paymentAttemptId'],
  },
  {
    child: 'Order',
    column: 'paymentAttemptId',
    parent: 'PaymentAttempt',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'order',
    spareParent: 'payment-spare',
    uniqueColumns: ['orderNumber', 'accessToken'],
  },
  {
    child: 'OrderLine',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'line',
    spareParent: 'order-2',
    uniqueColumns: [],
  },
  {
    child: 'OrderStatusHistory',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'history',
    spareParent: 'order-2',
    uniqueColumns: [],
  },
  {
    child: 'PaymentAttempt',
    column: 'locationId',
    parent: 'Location',
    onDelete: 'RESTRICT',
    optional: true,
    childRow: 'payment',
    spareParent: 'location-spare',
    uniqueColumns: ['idempotencyKey'],
  },
];
const relationshipId = (r: Relationship) => `${r.child}.${r.column}`;
const constraintName = (r: Relationship) =>
  `${r.child}_tenantId_${r.column}_fkey`;

// The catalog shape every enforced relationship must have.
const EXPECTED_FOREIGN_KEYS = RELATIONSHIPS.map(
  (r) =>
    `${constraintName(r)}: FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", id) ON UPDATE RESTRICT ON DELETE ${r.onDelete}`,
).sort();

// The six tables holding the references: an existing row never changes
// business.
const CHILD_TABLES = [...new Set(RELATIONSHIPS.map((r) => r.child))].sort();
const EXPECTED_TRIGGERS = CHILD_TABLES.map(
  (t) =>
    `trigger: CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON public."${t}" FOR EACH ROW WHEN ((old."tenantId" IS DISTINCT FROM new."tenantId")) EXECUTE FUNCTION reject_tenant_reassignment()`,
);
const EXPECTED_ENFORCEMENT = [...EXPECTED_FOREIGN_KEYS, ...EXPECTED_TRIGGERS];

// Every foreign key on the nine referencing columns, as PostgreSQL defines
// it, then every trigger on "tenantId" of the six tables. Exactly
// EXPECTED_ENFORCEMENT means: composite, on the right parent key, the right
// delete action, no single-column key left behind, and no row can move.
async function tenantEnforcement(client: Client): Promise<string[]> {
  const keys = await client.query<{ d: string }>(
    `SELECT c.conname || ': ' || pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND EXISTS (
          SELECT 1 FROM unnest(c.conkey) k(n)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
           WHERE (c.conrelid::regclass::text, a.attname::text) IN (${RELATIONSHIPS.map(
             (r) => `('"${r.child}"', '${r.column}')`,
           ).join(', ')})
        )
      ORDER BY c.conname COLLATE "C"`,
  );
  const triggers = await client.query<{ d: string }>(
    `SELECT 'trigger: ' || pg_get_triggerdef(t.oid) AS d
       FROM pg_trigger t
      WHERE NOT t.tgisinternal
        AND t.tgrelid::regclass::text IN (${CHILD_TABLES.map((t) => `'"${t}"'`).join(', ')})
        AND EXISTS (
          SELECT 1 FROM unnest(t.tgattr::int2[]) k(n)
            JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.n
           WHERE a.attname = 'tenantId'
        )
      ORDER BY (SELECT c.relname FROM pg_class c WHERE c.oid = t.tgrelid) COLLATE "C"`,
  );
  return [...keys.rows, ...triggers.rows].map((r) => r.d);
}

// Fictional data for one business: every enforced relationship is in use,
// plus unused "spare" parents to point rows at.
async function loadBusiness(prisma: PrismaClient, tag: Tag) {
  const tenantId = TENANTS[tag];
  await prisma.internalUser.create({
    data: {
      id: id(tag, 'staff'),
      tenantId,
      externalProvider: 'dev',
      externalSubject: id(tag, 'staff'),
      email: `${tag}.fk.staff@example.test`,
    },
  });
  for (const name of ['location', 'location-spare', 'location-pref']) {
    await prisma.location.create({
      data: { id: id(tag, name), tenantId, name, slug: id(tag, name) },
    });
  }
  // A real product for the order line's historical snapshot.
  await prisma.category.create({
    data: {
      id: id(tag, 'category'),
      tenantId,
      name: 'Drinks',
      slug: id(tag, 'category'),
    },
  });
  await prisma.product.create({
    data: {
      id: id(tag, 'product'),
      tenantId,
      name: 'Fictional Latte',
      slug: id(tag, 'product'),
      categoryId: id(tag, 'category'),
    },
  });
  for (const name of ['customer', 'customer-spare']) {
    await prisma.customer.create({
      data: {
        id: id(tag, name),
        tenantId,
        externalProvider: 'dev',
        externalSubject: id(tag, name),
      },
    });
  }
  const payments: Array<[string, string]> = [
    ['payment', 'location'],
    ['payment-2', 'location'],
    // Referenced by no order: its location is referenced by it alone.
    ['payment-spare', 'location-spare'],
  ];
  for (const [name, location] of payments) {
    await prisma.paymentAttempt.create({
      data: {
        id: id(tag, name),
        tenantId,
        idempotencyKey: id(tag, name),
        provider: 'fake',
        amount: 500,
        currency: 'USD',
        locationId: id(tag, location),
      },
    });
  }
  // Nested lines and history: their tenantId comes from the Order through
  // the composite key (Prisma does not accept one in a nested create).
  await prisma.order.create({
    data: {
      id: id(tag, 'order'),
      tenantId,
      orderNumber: id(tag, 'order'),
      accessToken: id(tag, 'order-token'),
      locationId: id(tag, 'location'),
      customerId: id(tag, 'customer'),
      paymentAttemptId: id(tag, 'payment'),
      guestName: 'Fictional Guest',
      guestPhone: '5550000000',
      currency: 'USD',
      subtotal: 500,
      lines: {
        create: {
          id: id(tag, 'line'),
          productId: id(tag, 'product'),
          productName: 'Fictional Latte',
          unitPrice: 500,
          quantity: 1,
          lineTotal: 500,
          currency: 'USD',
          selections: [],
        },
      },
      statusHistory: { create: { id: id(tag, 'history'), status: 'RECEIVED' } },
    },
  });
  await prisma.order.create({
    data: {
      id: id(tag, 'order-2'),
      tenantId,
      orderNumber: id(tag, 'order-2'),
      accessToken: id(tag, 'order-2-token'),
      locationId: id(tag, 'location'),
      customerId: null,
      paymentAttemptId: id(tag, 'payment-2'),
      guestName: 'Fictional Guest',
      guestPhone: '5550000000',
      currency: 'USD',
      subtotal: 500,
    },
  });
  await prisma.customerNote.create({
    data: {
      id: id(tag, 'note'),
      tenantId,
      customerId: id(tag, 'customer'),
      authorInternalUserId: id(tag, 'staff'),
      body: 'Fictional note',
    },
  });
  await prisma.customerPreferredLocation.create({
    data: {
      id: id(tag, 'pref'),
      tenantId,
      customerId: id(tag, 'customer'),
      locationId: id(tag, 'location'),
    },
  });
  // A location referenced only by a saved preference (CASCADE on delete).
  await prisma.customerPreferredLocation.create({
    data: {
      id: id(tag, 'pref-2'),
      tenantId,
      customerId: id(tag, 'customer-spare'),
      locationId: id(tag, 'location-pref'),
    },
  });
}

async function loadFixture(url: string) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    for (const tag of ['b', 'c'] as const) {
      await prisma.tenant.create({
        data: {
          id: TENANTS[tag],
          slug: `test-tenant-${tag}`,
          name: `Test Tenant ${tag.toUpperCase()}`,
          status: 'ACTIVE',
        },
      });
    }
    for (const tag of TAGS) await loadBusiness(prisma, tag);
  } finally {
    await prisma.$disconnect();
  }
}

// A checksum of every row of every table (excluding Prisma's own history).
async function dataChecksum(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ sum: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS sum FROM "${name}" t`,
      );
      parts.push(`${name}:${rows[0].sum}`);
    }
    return parts.join(',');
  });
}

// Runs `sql` in a transaction that is always rolled back; returns 'ok' or
// the PostgreSQL error code and constraint.
async function attempt(
  client: Client,
  sql: string,
  then?: () => Promise<unknown>,
): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await then?.();
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return `${e.code}${e.constraint ? ` ${e.constraint}` : ''}`;
  } finally {
    await client.query('ROLLBACK');
  }
}

// A rejected Prisma write as `<Prisma code>/<SQLSTATE>` — or 'accepted'.
const prismaOutcome = (write: Promise<unknown>) =>
  write.then(
    () => 'accepted',
    (e: {
      code?: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    }) => `${e.code}/${e.meta?.driverAdapterError?.cause?.originalCode ?? '-'}`,
  );

// A copy of the child row with a new id and the referencing column set to
// `parentId` — a direct-SQL INSERT whose only possible failure is the
// foreign key under test.
const insertCopy = (r: Relationship, from: Tag, parentId: string | null) => {
  const overrides: Record<string, string | null> = {
    id: `copy-${from}-${r.childRow}`,
    [r.column]: parentId,
  };
  for (const column of r.uniqueColumns) {
    overrides[column] =
      column === 'paymentAttemptId'
        ? id(from, 'payment-spare')
        : `copy-${from}-${column}`;
  }
  return `INSERT INTO "${r.child}"
    SELECT (jsonb_populate_record(NULL::"${r.child}", to_jsonb(t) || '${JSON.stringify(overrides)}'::jsonb)).*
      FROM "${r.child}" t WHERE id = '${id(from, r.childRow)}'`;
};

describe('Tenant-enforced foreign keys: customers, orders, payments (Security 4C-3)', () => {
  it('the inventory marks exactly these nine relationships as tenant-enforced, with matching delete rules', () => {
    const enforced = TENANT_RELATIONSHIPS.filter(
      (r): r is DirectReference =>
        'tenantEnforced' in r && r.tenantEnforced === true,
    );
    const rule = { CASCADE: 'Cascade', RESTRICT: 'Restrict' } as const;
    expect(
      enforced.map((r) => `${r.id}->${r.target} ${r.onDelete}`).sort(),
    ).toEqual(
      RELATIONSHIPS.map(
        (r) =>
          `${relationshipId(r)}->${r.parent} ${r.onDelete in rule ? rule[r.onDelete as keyof typeof rule] : 'SetNull'}`,
      ).sort(),
    );
  });

  it('schema.prisma declares each of them as a (tenantId, column) -> (tenantId, id) relation with ON UPDATE RESTRICT', () => {
    const models = new Map(
      [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    for (const r of RELATIONSHIPS) {
      const body = models.get(r.child) ?? '';
      const relation = new RegExp(
        `^\\s+\\w+\\s+${r.parent}\\??\\s+@relation\\(fields: \\[tenantId, ${r.column}\\], references: \\[tenantId, id\\], onDelete: (\\w+), onUpdate: Restrict\\)`,
        'm',
      ).exec(body);
      expect([relationshipId(r), relation?.[1]]).toEqual([
        relationshipId(r),
        r.onDelete === 'CASCADE'
          ? 'Cascade'
          : r.onDelete === 'RESTRICT'
            ? 'Restrict'
            : 'SetNull',
      ]);
    }
  });

  it('the migration is ONE DO block: version check, read-only preflight of all nine, lock_timeout, then the keys', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(migrations[targetIndex - 1].name).toBe(
      '20261011090000_tenant_composite_keys',
    );
    const sql = target.sql;
    // A dollar-quoted file is the only shape Prisma sends as one statement.
    expect(isAppliedAtomically(sql)).toBe(true);
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    expect(code).toMatch(
      /^DO \$tenant_fk_customer_order_payment\$[\s\S]*\$tenant_fk_customer_order_payment\$;$/,
    );
    expect(code.match(/\$tenant_fk_customer_order_payment\$/g)).toHaveLength(2);
    const order = [
      "set_config('lock_timeout', '5s', true)",
      "current_setting('server_version_num')::int < 150000",
      ...RELATIONSHIPS.map(
        (r) => `('${r.child}', '${r.column}', '${r.parent}')`,
      ),
      'Security 4C-3 aborted',
      'DROP CONSTRAINT',
      'ADD CONSTRAINT',
      'CREATE FUNCTION "reject_tenant_reassignment"()',
      'CREATE TRIGGER',
    ].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // The keys, exactly as expected; data is never updated or deleted.
    for (const r of RELATIONSHIPS) {
      expect(code).toContain(
        `ADD CONSTRAINT "${constraintName(r)}" FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", "id") ON DELETE ${r.onDelete} ON UPDATE RESTRICT;`,
      );
    }
    for (const t of CHILD_TABLES) {
      expect(code).toContain(
        `CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "${t}"`,
      );
    }
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(6);
    expect(code).toContain("USING ERRCODE = 'restrict_violation'");
    expect(code).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the rollback is ONE DO block that restores the eight original keys and drops the nine composite ones and the six triggers', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    for (const t of CHILD_TABLES) {
      expect(rollbackSql).toContain(
        `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}";`,
      );
    }
    expect(rollbackSql).toContain(
      'DROP FUNCTION "reject_tenant_reassignment"();',
    );
    for (const r of RELATIONSHIPS) {
      expect(rollbackSql).toContain(`DROP CONSTRAINT "${constraintName(r)}"`);
    }
    expect(rollbackSql.match(/ADD CONSTRAINT "\w+_fkey"/g)).toHaveLength(8);
    expect(rollbackSql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the migrated test database enforces all nine relationships (catalog regression guard)', async () => {
    expect(
      await withScratchClient(baseUrl, (client) => tenantEnforcement(client)),
    ).toEqual(EXPECTED_ENFORCEMENT);
  });

  describe('on a scratch database with three fictional businesses', () => {
    let scratch: ScratchDatabase;
    let prisma: PrismaClient;
    let beforeData: string;
    const sql = <T>(fn: (client: Client) => Promise<T>) =>
      withScratchClient(scratch.url, fn);

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'fk_cop');
      await applyMigrations(scratch.url, migrations);
      await loadFixture(scratch.url);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: scratch.url }),
      });
      beforeData = await dataChecksum(scratch.url);
    });
    afterAll(async () => {
      await prisma?.$disconnect();
      await scratch?.drop();
    });

    it('carries exactly the expected foreign keys', async () => {
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
    });

    it('accepts same-business references, by UPDATE and by INSERT, for every relationship and business', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const x of TAGS) {
            const update = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${id(x, r.spareParent)}' WHERE id = '${id(x, r.childRow)}'`,
            );
            const insert = await attempt(
              client,
              insertCopy(r, x, id(x, r.spareParent)),
            );
            out.push(`${relationshipId(r)} ${x}: ${update}/${insert}`);
          }
        }
        return out;
      });
      expect(results.filter((s) => !s.endsWith(': ok/ok'))).toEqual([]);
      expect(results).toHaveLength(27);
    });

    it('rejects every cross-business reference by direct SQL — every relationship, every ordered pair, UPDATE and INSERT', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const [x, y] of PAIRS) {
            const expected = `23503 ${constraintName(r)}`;
            const update = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${id(y, r.spareParent)}' WHERE id = '${id(x, r.childRow)}'`,
            );
            const insert = await attempt(
              client,
              insertCopy(r, x, id(y, r.spareParent)),
            );
            if (update !== expected || insert !== expected) {
              out.push(`${relationshipId(r)} ${x}->${y}: ${update}/${insert}`);
            }
          }
        }
        return out;
      });
      expect(results).toEqual([]);
    });

    it('rejects a reference to a record that does not exist', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          out.push(
            await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = 'fk-missing' WHERE id = '${id('b', r.childRow)}'`,
            ),
          );
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.map((r) => `23503 ${constraintName(r)}`),
      );
    });

    it('rejects moving any referencing row to another business (tenantId is immutable)', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const [x, y] of PAIRS) {
            const result = await attempt(
              client,
              `UPDATE "${r.child}" SET "tenantId" = '${TENANTS[y]}' WHERE id = '${id(x, r.childRow)}'`,
            );
            if (result !== '23001') {
              out.push(`${relationshipId(r)} ${x}->${y}: ${result}`);
            }
          }
        }
        return out;
      });
      expect(results).toEqual([]);
    });

    it('rejects moving a referenced parent to another business (ON UPDATE RESTRICT, or immutable tenantId)', async () => {
      const parents = [
        ['Customer', 'customer'],
        ['Location', 'location'],
        ['PaymentAttempt', 'payment'],
        ['Order', 'order'],
      ];
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const [table, name] of parents) {
          for (const [x, y] of PAIRS) {
            out.push(
              `${table} ${x}->${y}: ${
                (
                  await attempt(
                    client,
                    `UPDATE "${table}" SET "tenantId" = '${TENANTS[y]}' WHERE id = '${id(x, name)}'`,
                  )
                ).split(' ')[0]
              }`,
            );
          }
        }
        return out;
      });
      // Customers and locations: the referencing keys' ON UPDATE RESTRICT;
      // payment attempts and orders: their own immutable tenantId.
      expect(
        results.filter(
          (s) =>
            !s.endsWith(
              /^(Customer|Location) /.test(s) ? ': 23503' : ': 23001',
            ),
        ),
      ).toEqual([]);
      expect(results).toHaveLength(24);
    });

    it('optional references may be NULL; required ones still may not', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          const result = await attempt(
            client,
            `UPDATE "${r.child}" SET "${r.column}" = NULL WHERE id = '${id('c', r.childRow)}'`,
          );
          out.push(`${relationshipId(r)}: ${result.split(' ')[0]}`);
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.map(
          (r) => `${relationshipId(r)}: ${r.optional ? 'ok' : '23502'}`,
        ),
      );
    });

    it('Prisma nested connects naming another business’s record are rejected, and nothing changes', async () => {
      const a = (name: string) => id('a', name);
      const b = (name: string) => id('b', name);
      const rejected = prismaOutcome;
      const results = {
        orderCustomerByTenantKey: await rejected(
          prisma.order.update({
            where: { id: a('order') },
            data: {
              customer: {
                connect: {
                  tenantId_id: { tenantId: TENANTS.b, id: b('customer') },
                },
              },
            },
          }),
        ),
        orderCustomerById: await rejected(
          prisma.order.update({
            where: { id: a('order') },
            data: { customer: { connect: { id: b('customer-spare') } } },
          }),
        ),
        orderLocationById: await rejected(
          prisma.order.update({
            where: { id: a('order') },
            data: { location: { connect: { id: b('location-spare') } } },
          }),
        ),
        paymentLocationById: await rejected(
          prisma.paymentAttempt.update({
            where: { id: a('payment') },
            data: { location: { connect: { id: b('location-spare') } } },
          }),
        ),
        noteCustomerById: await rejected(
          prisma.customerNote.update({
            where: { id: a('note') },
            data: { customer: { connect: { id: b('customer-spare') } } },
          }),
        ),
        prefLocationById: await rejected(
          prisma.customerPreferredLocation.update({
            where: { id: a('pref') },
            data: { location: { connect: { id: b('location-spare') } } },
          }),
        ),
        lineOrderById: await rejected(
          prisma.orderLine.update({
            where: { id: a('line') },
            data: { order: { connect: { id: b('order-2') } } },
          }),
        ),
        historyOrderById: await rejected(
          prisma.orderStatusHistory.update({
            where: { id: a('history') },
            data: { order: { connect: { id: b('order-2') } } },
          }),
        ),
        uncheckedScalar: await rejected(
          prisma.order.update({
            where: { id: a('order') },
            data: { customerId: b('customer-spare') },
          }),
        ),
        nestedCreateUnderOtherBusinessParent: await rejected(
          prisma.order.update({
            where: { id: a('order') },
            data: {
              statusHistory: {
                create: { id: 'fk-nested', status: 'RECEIVED' },
              },
              location: { connect: { id: b('location-spare') } },
            },
          }),
        ),
        checkoutStyleCreate: await rejected(
          prisma.order.create({
            data: {
              tenantId: TENANTS.a,
              orderNumber: 'fk-cross-create',
              accessToken: 'fk-cross-create',
              locationId: b('location-spare'),
              paymentAttemptId: a('payment-spare'),
              guestName: 'Fictional Guest',
              guestPhone: '5550000000',
              currency: 'USD',
              subtotal: 500,
              statusHistory: { create: { status: 'RECEIVED' } },
            },
          }),
        ),
      };
      // Every connect to another business's record would move the row to
      // that business (Prisma writes tenantId with the reference): refused
      // by the immutable tenantId (23001). Writing the scalar column instead
      // keeps tenantId and is refused by the composite key (23503).
      const moved = 'P2039/23001';
      const crossKey = 'P2003/23503';
      expect(results).toEqual({
        orderCustomerByTenantKey: moved,
        orderCustomerById: moved,
        orderLocationById: moved,
        paymentLocationById: moved,
        noteCustomerById: moved,
        prefLocationById: moved,
        lineOrderById: moved,
        historyOrderById: moved,
        uncheckedScalar: crossKey,
        nestedCreateUnderOtherBusinessParent: moved,
        checkoutStyleCreate: crossKey,
      });
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business Prisma connects still work', async () => {
      await prisma
        .$transaction(async (tx) => {
          await tx.order.update({
            where: { id: id('b', 'order') },
            data: {
              customer: { connect: { id: id('b', 'customer-spare') } },
              location: { connect: { id: id('b', 'location-spare') } },
            },
          });
          const order = await tx.order.findUniqueOrThrow({
            where: { id: id('b', 'order') },
          });
          expect([order.tenantId, order.customerId, order.locationId]).toEqual([
            TENANTS.b,
            id('b', 'customer-spare'),
            id('b', 'location-spare'),
          ]);
          // Clearing the optional customer: set the column to null (a
          // relation `disconnect` would null the shared tenantId too).
          await tx.order.update({
            where: { id: id('b', 'order') },
            data: { customerId: null },
          });
          expect(
            (
              await tx.order.findUniqueOrThrow({
                where: { id: id('b', 'order') },
              })
            ).customerId,
          ).toBeNull();
          throw new Error('roll back');
        })
        .catch((e: Error) => expect(e.message).toBe('roll back'));
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('a relation disconnect of an optional composite reference is refused (it would null tenantId) and changes nothing', async () => {
      const disconnect = prismaOutcome;
      expect(
        await disconnect(
          prisma.order.update({
            where: { id: id('a', 'order') },
            data: { customer: { disconnect: true } },
          }),
        ),
      ).toBe('P2039/23001');
      expect(
        await disconnect(
          prisma.paymentAttempt.update({
            where: { id: id('a', 'payment') },
            data: { location: { disconnect: true } },
          }),
        ),
      ).toBe('P2039/23001');
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejected writes left every row unchanged, and the integrity checker reports CLEAN with zero unchecked rows', async () => {
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
      const report = await sql((client) => checkTenantIntegrity(client));
      expect(report.findings).toEqual([]);
      expect(report.violations).toBe(0);
      expect(report.uncheckedRows).toBe(0);
      expect(report.verdict).toBe('clean');
    });

    it('a deliberately removed composite key is detected by the catalog guard, and would let a cross-business write through', async () => {
      const removed = RELATIONSHIPS.find(
        (r) => r.child === 'Order' && r.column === 'customerId',
      )!;
      const outcome = await sql(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `ALTER TABLE "Order" DROP CONSTRAINT "${constraintName(removed)}"`,
          );
          const keys = await tenantEnforcement(client);
          await client.query(
            `UPDATE "Order" SET "customerId" = '${id('b', 'customer-spare')}' WHERE id = '${id('a', 'order')}'`,
          );
          return keys;
        } finally {
          await client.query('ROLLBACK');
        }
      });
      expect(outcome).not.toEqual(EXPECTED_ENFORCEMENT);
      expect(EXPECTED_FOREIGN_KEYS.filter((k) => !outcome.includes(k))).toEqual(
        [
          EXPECTED_FOREIGN_KEYS.find((k) =>
            k.startsWith(constraintName(removed)),
          ),
        ],
      );
      // Rolled back: enforced again.
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('a deliberately removed immutability trigger is detected, and would let a row move to another business', async () => {
      const outcome = await sql(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `DROP TRIGGER "CustomerNote_tenantId_immutable" ON "CustomerNote"`,
          );
          const enforcement = await tenantEnforcement(client);
          // What a nested connect to B's customer does to A's note.
          await client.query(
            `UPDATE "CustomerNote" SET "tenantId" = '${TENANTS.b}', "customerId" = '${id('b', 'customer-spare')}' WHERE id = '${id('a', 'note')}'`,
          );
          return enforcement;
        } finally {
          await client.query('ROLLBACK');
        }
      });
      expect(EXPECTED_ENFORCEMENT.filter((k) => !outcome.includes(k))).toEqual([
        EXPECTED_TRIGGERS[0],
      ]);
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });

  // Delete behaviour is compared against a database migrated to just
  // before 4C-3 holding the identical fictional rows.
  describe('deletion behaviour is unchanged', () => {
    let before: ScratchDatabase;
    let after: ScratchDatabase;

    beforeAll(async () => {
      before = await createScratchDatabase(baseUrl, 'fk_cop_del_before');
      after = await createScratchDatabase(baseUrl, 'fk_cop_del_after');
      await applyMigrations(before.url, migrations.slice(0, targetIndex));
      await applyMigrations(after.url, migrations);
      await loadFixture(before.url);
      await loadFixture(after.url);
    });
    afterAll(async () => {
      await before?.drop();
      await after?.drop();
    });

    // The rows of the nine relationships (ids + references), after `sql`
    // ran — or the error — inside a rolled-back transaction.
    const outcome = (url: string, statement: string) =>
      withScratchClient(url, async (client) => {
        let state = '';
        const result = await attempt(client, statement, async () => {
          const parts: string[] = [];
          for (const table of [
            'Customer',
            'Location',
            'PaymentAttempt',
            'Order',
            'OrderLine',
            'OrderStatusHistory',
            'CustomerNote',
            'CustomerPreferredLocation',
          ]) {
            const { rows } = await client.query<{ r: string }>(
              `SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) AS r FROM (
                 SELECT id, "tenantId"${
                   {
                     Order: ', "locationId", "customerId", "paymentAttemptId"',
                     PaymentAttempt: ', "locationId"',
                     OrderLine: ', "orderId"',
                     OrderStatusHistory: ', "orderId"',
                     CustomerNote: ', "customerId"',
                     CustomerPreferredLocation: ', "customerId", "locationId"',
                   }[table] ?? ''
                 } FROM "${table}") x`,
            );
            parts.push(`${table}:${rows[0].r}`);
          }
          state = parts.join('\n');
        });
        return result === 'ok' ? state : result.split(' ')[0];
      });

    const deletes = TAGS.flatMap((tag) => [
      // CASCADE notes and saved locations; SET NULL only the order's customerId.
      [
        `customer ${tag}`,
        `DELETE FROM "Customer" WHERE id = '${id(tag, 'customer')}'`,
      ],
      [
        `spare customer ${tag}`,
        `DELETE FROM "Customer" WHERE id = '${id(tag, 'customer-spare')}'`,
      ],
      // RESTRICT: orders reference it.
      [
        `location ${tag}`,
        `DELETE FROM "Location" WHERE id = '${id(tag, 'location')}'`,
      ],
      // CASCADE: only a saved location references it.
      [
        `saved location ${tag}`,
        `DELETE FROM "Location" WHERE id = '${id(tag, 'location-pref')}'`,
      ],
      // RESTRICT: lines and history reference it.
      [`order ${tag}`, `DELETE FROM "Order" WHERE id = '${id(tag, 'order')}'`],
      // An order with no lines or history can still be deleted.
      [
        `order-2 ${tag}`,
        `DELETE FROM "Order" WHERE id = '${id(tag, 'order-2')}'`,
      ],
      // RESTRICT: an order references it.
      [
        `payment ${tag}`,
        `DELETE FROM "PaymentAttempt" WHERE id = '${id(tag, 'payment')}'`,
      ],
      [
        `unclaimed payment ${tag}`,
        `DELETE FROM "PaymentAttempt" WHERE id = '${id(tag, 'payment-spare')}'`,
      ],
      [
        `order lines ${tag}`,
        `DELETE FROM "OrderLine" WHERE "orderId" = '${id(tag, 'order')}'`,
      ],
    ]);

    it('every delete has the same outcome before and after 4C-3', async () => {
      const differences: string[] = [];
      for (const [label, statement] of deletes) {
        const was = await outcome(before.url, statement);
        const is = await outcome(after.url, statement);
        if (was !== is) differences.push(label);
      }
      expect(differences).toEqual([]);
    });

    it('deleting a customer nulls only Order.customerId — the order keeps its business', async () => {
      const state = await outcome(
        after.url,
        `DELETE FROM "Customer" WHERE id = '${id('b', 'customer')}'`,
      );
      expect(state).toContain(
        `{"id":"${id('b', 'order')}","tenantId":"${TENANTS.b}","locationId":"${id('b', 'location')}","customerId":null,"paymentAttemptId":"${id('b', 'payment')}"}`,
      );
      expect(state).not.toContain(`"${id('b', 'note')}"`);
      expect(state).not.toContain(`"${id('b', 'pref')}"`);
    });

    it('the one intended change: a location referenced only by a payment attempt can no longer be deleted (new PaymentAttempt.locationId RESTRICT)', async () => {
      const statement = `DELETE FROM "Location" WHERE id = '${id('c', 'location-spare')}'`;
      // Before 4C-3 the delete succeeded and left the payment attempt
      // pointing at a location that no longer existed.
      expect(await outcome(before.url, statement)).toContain(
        `{"id":"${id('c', 'payment-spare')}","tenantId":"${TENANTS.c}","locationId":"${id('c', 'location-spare')}"}`,
      );
      expect(await outcome(after.url, statement)).toBe('23503');
    });
  });

  // Real `prisma migrate deploy`, exactly as CI and every environment run
  // it, against newly created guarded scratch databases. A temporary project
  // holding copies of the migrations up to 4C-2 stands in for an environment
  // that has not applied 4C-3 yet.
  describe('applied by real prisma migrate deploy', () => {
    const prisma = prismaCli(databaseDir);
    const projects: MigrationProject[] = [];
    const scratches: ScratchDatabase[] = [];
    const beforeNames = migrations.slice(0, targetIndex).map((m) => m.name);

    afterAll(async () => {
      for (const scratch of scratches) await scratch.drop();
      for (const p of projects) p.remove();
    });

    const project = (
      names: string[],
      extra?: ExtraMigration | ExtraMigration[],
    ) => {
      const created = createMigrationProject(migrationsDir, names, extra);
      projects.push(created);
      return created.config;
    };
    const fresh = async (label: string) => {
      const scratch = await createScratchDatabase(baseUrl, label);
      scratches.push(scratch);
      return scratch;
    };
    // A database at the migration before 4C-3, holding the fixture.
    const beforeFourC3 = async (label: string) => {
      const scratch = await fresh(label);
      const result = await prisma(
        scratch.url,
        ['migrate', 'deploy'],
        project(beforeNames),
      );
      expect(result.code).toBe(0);
      await loadFixture(scratch.url);
      return scratch;
    };
    const run = (url: string, statement: string) =>
      withScratchClient(url, (client) => client.query(statement));
    const migrationRow = async (url: string) =>
      (
        await withScratchClient(url, (client) =>
          client.query<{ finished: boolean; rolled_back: boolean }>(
            `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
               FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'
              ORDER BY started_at`,
          ),
        )
      ).rows.map(
        (r) =>
          `${r.finished ? 'finished' : 'unfinished'}${r.rolled_back ? '+rolled-back' : ''}`,
      );
    const noDrift = async (url: string) =>
      (
        await prisma(url, [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ])
      ).code;
    const foreignKeys = (url: string) =>
      withScratchClient(url, tenantEnforcement);

    it('succeeds on clean data: all nine keys, data unchanged, no drift, integrity CLEAN', async () => {
      const scratch = await beforeFourC3('fk_cop_ok');
      const data = await dataChecksum(scratch.url);
      const result = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(result.code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await foreignKeys(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await noDrift(scratch.url)).toBe(0);
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('a cross-business row aborts it before any change, is recorded as failed, cannot be retried as success, and recovers only after an explicit fix', async () => {
      const scratch = await beforeFourC3('fk_cop_cross');
      // Legacy-style bad data: A's order names B's customer.
      await run(
        scratch.url,
        `UPDATE "Order" SET "customerId" = '${id('b', 'customer-spare')}' WHERE id = '${id('a', 'order')}'`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);

      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toContain('Security 4C-3 aborted');
      expect(failed.out).toContain('Order.customerId -> Customer: 1 row(s)');
      expect(failed.out).not.toContain('Order.locationId');
      // Nothing changed — no key, no data, and no ownership reassigned.
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);

      const retried = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(retried.code).not.toBe(0);
      expect(retried.out).toContain('P3009');
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);

      // Documented recovery: an explicit, deliberate fix of the reported
      // row (here: restore the order's own customer), mark the failed attempt
      // rolled back, deploy again.
      await run(
        scratch.url,
        `UPDATE "Order" SET "customerId" = '${id('a', 'customer')}' WHERE id = '${id('a', 'order')}'`,
      );
      expect(
        (
          await prisma(scratch.url, [
            'migrate',
            'resolve',
            '--rolled-back',
            MIGRATION,
          ])
        ).code,
      ).toBe(0);
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual([
        'unfinished+rolled-back',
        'finished',
      ]);
      expect(await foreignKeys(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await noDrift(scratch.url)).toBe(0);
    });

    it('reports every mismatched relationship at once, including references to missing records', async () => {
      const scratch = await beforeFourC3('fk_cop_many');
      await run(
        scratch.url,
        `UPDATE "PaymentAttempt" SET "locationId" = 'fk-missing' WHERE id = '${id('c', 'payment-spare')}';
         UPDATE "OrderLine" SET "orderId" = '${id('c', 'order-2')}' WHERE id = '${id('b', 'line')}';
         UPDATE "CustomerPreferredLocation" SET "locationId" = '${id('a', 'location-spare')}' WHERE id IN ('${id('b', 'pref')}', '${id('c', 'pref')}');`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);
      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain(
        'PaymentAttempt.locationId -> Location: 1 row(s)',
      );
      expect(failed.out).toContain('OrderLine.orderId -> Order: 1 row(s)');
      expect(failed.out).toContain(
        'CustomerPreferredLocation.locationId -> Location: 2 row(s)',
      );
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
    });

    it('a failure at its LAST statement leaves no partial change', async () => {
      const scratch = await beforeFourC3('fk_cop_late');
      // Occupy the name of the last trigger it creates, so only its very
      // last statement fails — after the preflight, the eight drops, the
      // index, the nine keys, the function and five triggers.
      await run(
        scratch.url,
        `CREATE TRIGGER "PaymentAttempt_tenantId_immutable" BEFORE UPDATE ON "PaymentAttempt"
           FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);
      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toMatch(/already exists/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('a lock it cannot get makes it fail fast (lock_timeout) and atomically', async () => {
      const scratch = await beforeFourC3('fk_cop_lock');
      const catalog = await databaseCatalog(scratch.url);
      const held = await withScratchClient(scratch.url, async (client) => {
        // An open writer on the last child table for the whole deploy.
        await client.query('BEGIN');
        await client.query(`LOCK TABLE "CustomerNote" IN ROW EXCLUSIVE MODE`);
        const started = Date.now();
        const result = await prisma(scratch.url, ['migrate', 'deploy']);
        await client.query('ROLLBACK');
        return { result, seconds: (Date.now() - started) / 1000 };
      });
      expect(held.result.code).not.toBe(0);
      expect(held.result.out).toMatch(/lock timeout/i);
      expect(held.seconds).toBeLessThan(60);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('the documented rollback — shipped as a new forward migration — restores the pre-4C-3 catalog exactly, keeps the data, and 4C-3 re-applies', async () => {
      const scratch = await beforeFourC3('fk_cop_rollback');
      const data = await dataChecksum(scratch.url);
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      const all = migrations.map((m) => m.name);
      const rollback = {
        name: '20261012100000_rollback_tenant_fk_customer_order_payment',
        sql: rollbackSql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(all, rollback),
          )
        ).code,
      ).toBe(0);
      const reference = await fresh('fk_cop_rollback_ref');
      expect(
        (
          await prisma(
            reference.url,
            ['migrate', 'deploy'],
            project(beforeNames),
          )
        ).code,
      ).toBe(0);
      expect(await databaseCatalog(scratch.url)).toEqual(
        await databaseCatalog(reference.url),
      );
      expect(await dataChecksum(scratch.url)).toBe(data);
      // Forward again (as a later migration would): the keys come back.
      const reapply = {
        name: '20261012110000_reapply_tenant_fk_customer_order_payment',
        sql: target.sql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(all, [rollback, reapply]),
          )
        ).code,
      ).toBe(0);
      expect(await foreignKeys(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
    });
  });
});
