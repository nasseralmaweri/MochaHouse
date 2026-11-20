import { Client } from "pg";
import { assertDisposableDatabase } from "./disposable-database";

// V1 Sales Tax PR 1 — removes the sales tax settings of the given test
// businesses (tax classes, every location tax version and its taxes, category
// and product classifications) and their tax audit history. Confirmed
// versions are guarded against deletion; this test-only removal bypasses the
// guard (session_replication_role = replica) on a database proven
// disposable first.
export async function removeTaxSettingsForTest(
  tenantIds: readonly string[],
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  if (tenantIds.length === 0) return;
  await assertDisposableDatabase(url);
  const client = new Client({ connectionString: url?.split("?")[0] });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const ids = [...tenantIds];
    await client.query(
      `DELETE FROM "LocationTaxComponentClass" WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM "LocationTaxComponent" WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM "LocationTaxVersion" WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `UPDATE "Category" SET "taxClassId" = NULL, "taxClassReviewedAt" = NULL
        WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `UPDATE "Product" SET "taxClassId" = NULL WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM "TaxClass" WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM "InternalAuditEvent"
        WHERE "tenantId" = ANY($1::text[]) AND "action" LIKE 'tax.%'`,
      [ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
