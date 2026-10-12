// Security 4C-1 — runs once before any suite in this app. Every suite here
// reads or writes the configured database, so the run proceeds only if
// that database is proven disposable (marker, token, test environment and
// fictional businesses — see assertDisposableDatabase). Fails closed.
import 'dotenv/config';
import { assertDisposableDatabase } from '@mocha-house/testing';

export default async function globalSetup(): Promise<void> {
  await assertDisposableDatabase();
}
