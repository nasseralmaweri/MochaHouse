-- Milestone S0F — Real Admin Tenant Resolution & Minimal Business Membership.
--
-- InternalUser's external-identity uniqueness moves from GLOBAL
-- (externalProvider, externalSubject) to PER TENANT
-- (tenantId, externalProvider, externalSubject). An InternalUser row is the
-- tenant-scoped membership (ADR-4 amendment); the verified external identity
-- is the human. A human may now be bound to at most one row per business,
-- which is exactly what lets one administrator legitimately belong to more
-- than one business. Which row applies to a request is decided by
-- InternalAuthGuard from a validated active-business selection.
--
-- No backfill is needed: every existing row already carries a NOT NULL
-- tenantId (S0D-2E), and rows that were unique on (externalProvider,
-- externalSubject) are necessarily unique on the wider key, so the new
-- unique index cannot fail on existing data and existing administrators
-- keep exactly the access they have today.
--
-- A plain (non-unique) index on (externalProvider, externalSubject) is kept
-- for the identity -> memberships lookup, which runs before any tenant is
-- known and so cannot use the tenant-leading unique index.
--
-- Created before the old index is dropped, so there is no instant (inside
-- this migration's transaction) where the identity is unconstrained.

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_tenantId_externalProvider_externalSubject_key" ON "InternalUser"("tenantId", "externalProvider", "externalSubject");

-- CreateIndex
CREATE INDEX "InternalUser_externalProvider_externalSubject_idx" ON "InternalUser"("externalProvider", "externalSubject");

-- DropIndex
DROP INDEX "InternalUser_externalProvider_externalSubject_key";
