import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  .sort();

// Milestone S0D-1 — the migrated schema, introspected from the live
// database (read-only). Table names equal model names (no @@map anywhere).
describe('S0D-1 tenant columns — schema introspection', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('covers exactly the 63 tenant-owned models', () => {
    expect(tenantTables).toHaveLength(63);
    expect(tenantTables).not.toContain('Tenant');
  });

  it('every tenant-owned table has a nullable TEXT tenantId with NO default, and no other table has one', async () => {
    const columns = await prisma.$queryRaw<
      {
        table_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      SELECT table_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
      ORDER BY table_name`;

    expect(columns.map((column) => column.table_name)).toEqual(tenantTables);
    for (const column of columns) {
      expect({ table: column.table_name, type: column.data_type }).toEqual({
        table: column.table_name,
        type: 'text',
      });
      // Nullable is intentional until each domain's S0D-2 slice.
      expect(column.is_nullable).toBe('YES');
      expect(column.column_default).toBeNull();
    }
  });

  it('Tenant itself is not tenantized', async () => {
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Tenant' AND column_name = 'tenantId'`;
    expect(Number(row.count)).toBe(0);
  });

  it('every tenantId has an FK to Tenant(id) with ON DELETE RESTRICT and ON UPDATE RESTRICT', async () => {
    const fks = await prisma.$queryRaw<
      {
        table_name: string;
        ref_table: string;
        ref_column: string;
        on_delete: string;
        on_update: string;
      }[]
    >`
      SELECT c.conrelid::regclass::text AS table_name,
             c.confrelid::regclass::text AS ref_table,
             ra.attname AS ref_column,
             c.confdeltype::text AS on_delete,
             c.confupdtype::text AS on_update
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND a.attname = 'tenantId' AND array_length(c.conkey, 1) = 1
      ORDER BY 1`;

    const unquote = (name: string) => name.replace(/^"|"$/g, '');
    expect(fks.map((fk) => unquote(fk.table_name)).sort()).toEqual(
      tenantTables,
    );
    for (const fk of fks) {
      // 'r' = RESTRICT in pg_constraint.
      expect(fk).toMatchObject({
        ref_table: '"Tenant"',
        ref_column: 'id',
        on_delete: 'r',
        on_update: 'r',
      });
    }
  });

  it('every tenant-owned table has an index led by tenantId', async () => {
    const indexed = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT DISTINCT t.relname AS table_name
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
      WHERE a.attname = 'tenantId'
      ORDER BY 1`;
    expect(indexed.map((row) => row.table_name)).toEqual(tenantTables);
  });

  it('no column anywhere defaults to Tenant #1', async () => {
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default LIKE ${`%${TENANT_1_MOCHA_HOUSE_ID}%`}`;
    expect(Number(row.count)).toBe(0);
  });
});
