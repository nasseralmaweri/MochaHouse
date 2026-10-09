-- Tenant isolation phase 2 — DRY RUN of the ownership backfill.
--
-- Runs the exact migration (20261010120000_tenant_isolation_phase_2) in
-- dry-run mode inside a transaction: the same relationship-derived
-- backfill executes, a per-table report is printed (rows with a NULL
-- tenantId, how many a reliable relationship resolves, and every
-- unresolved / conflicting / mismatched row id), and the migration then
-- aborts deliberately, so NOTHING is committed.
--
-- Run it ONLY against a restored copy of the database (never production):
--
--   psql "$RESTORED_COPY_URL" -v ON_ERROR_STOP=1 \
--     -f packages/database/prisma/scripts/tenant-isolation-phase-2-dry-run.sql
--
-- The run always ends with
--   ERROR: Tenant isolation phase 2 DRY RUN complete: N problem row(s). ...
-- N = 0 means the real migration will succeed on this data. N > 0 lists the
-- rows that need an explicit, approved ownership decision first.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL centerivo.tenant_backfill_dry_run = 'on';
\ir ../migrations/20261010120000_tenant_isolation_phase_2/migration.sql
ROLLBACK;
