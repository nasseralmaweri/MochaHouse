// Security 4C-1 — creates the database DATABASE_URL names as a NEW,
// disposable test database (see createDisposableDatabase). It connects to
// the server's maintenance database (`postgres`, or
// CENTERIVO_TEST_ADMIN_DATABASE) with the same credentials, refuses if the
// target already exists, and marks only the database it just created.
//
//   NODE_ENV=test CENTERIVO_TEST_DATABASE=1 CENTERIVO_TEST_DB_TOKEN=... \
//   DATABASE_URL=postgresql://.../mocha_ci pnpm --filter @mocha-house/testing db:create-disposable
//
// Prints only the database name — never the connection string.
import {
  DisposableDatabaseError,
  assertTestEnvironment,
  assertUnambiguousTestUrl,
  createDisposableDatabase,
} from "../disposable-database";

async function main(): Promise<void> {
  assertTestEnvironment();
  const target = process.env.DATABASE_URL;
  const database = assertUnambiguousTestUrl(target);
  const admin = new URL(target!);
  admin.pathname = `/${process.env.CENTERIVO_TEST_ADMIN_DATABASE ?? "postgres"}`;
  await createDisposableDatabase(admin.toString(), database);
  console.log(`Created disposable test database ${database}.`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof DisposableDatabaseError
      ? error.message
      : "Could not create the disposable test database.",
  );
  process.exit(1);
});
