import { Injectable } from '@nestjs/common';
import type { InternalBusinessSummary } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type { InternalIdentity } from '../infrastructure/internal-identity';

// Milestone S0F — "which businesses may this authenticated human enter?"
//
// There is no separate membership table. Under the ADR-4 amendment an
// InternalUser row IS the tenant-scoped membership: it carries the tenant,
// the lifecycle status and (through role assignments) every grant. The
// human behind it is the VERIFIED external identity (externalProvider,
// externalSubject), and since S0F that pair is unique per tenant rather
// than globally — so one human may hold at most one InternalUser row per
// business, and the set of their rows is the set of their memberships.
//
// A row matches the identity exactly the way InternalUsersService
// .resolveForAuthentication matches one inside a single tenant:
//   1. (externalProvider, externalSubject) — the bound identity; or
//   2. (externalProvider, email) with externalSubject still null — a row
//      provisioned by email that has not authenticated yet.
// Within one tenant the subject-bound row wins over an unbound email row,
// again mirroring resolveForAuthentication, so the business list and the
// per-request tenant decision can never disagree.
//
// This is deliberately a CROSS-tenant lookup keyed only by the verified
// identity — it is the one query that must run before any TenantContext
// exists. It returns membership facts only (tenant id/name/slug/status and
// the membership's own status); it never reads business data, and nothing
// it returns is trusted as a TenantContext by itself — the guard still
// re-resolves the InternalUser inside the chosen tenant.
export interface InternalTenantMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: 'ACTIVE' | 'SUSPENDED';
  userStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
}

// The outcome of choosing the active business for one request.
//   selected           — the identity is an ACTIVE member of this ACTIVE
//                        tenant; the guard may build a TenantContext for it.
//   selection-required — no business was requested and the identity can
//                        enter more than one; the client must choose.
//   denied             — the requested business is not one the identity may
//                        enter (not a member, membership not ACTIVE, tenant
//                        not ACTIVE, or simply no such tenant), or the
//                        identity can enter none at all. Every reason
//                        collapses to this one outcome so a caller can never
//                        probe which tenants exist.
export type ActiveTenantSelection =
  | { outcome: 'selected'; tenantId: string }
  | { outcome: 'selection-required' }
  | { outcome: 'denied' };

@Injectable()
export class InternalTenantMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async findMemberships(
    identity: InternalIdentity,
  ): Promise<InternalTenantMembership[]> {
    const matchers: Array<{
      externalProvider: string;
      externalSubject?: string | null;
      email?: string;
    }> = [];
    if (identity.subject) {
      matchers.push({
        externalProvider: identity.provider,
        externalSubject: identity.subject,
      });
    }
    // Security 4A — an unbound row is matched by email only when the
    // identity provider verified that email; otherwise an account that
    // merely claims someone's address could see (and then enter) a
    // business it was never invited to.
    if (identity.email && identity.emailVerified === true) {
      matchers.push({
        externalProvider: identity.provider,
        email: identity.email,
        externalSubject: null,
      });
    }
    if (matchers.length === 0) {
      return [];
    }

    const rows = await this.prisma.internalUser.findMany({
      where: { OR: matchers },
      select: {
        status: true,
        externalSubject: true,
        tenant: { select: { id: true, name: true, slug: true, status: true } },
      },
    });

    const byTenant = new Map<
      string,
      { membership: InternalTenantMembership; bound: boolean }
    >();
    for (const row of rows) {
      const bound =
        !!identity.subject && row.externalSubject === identity.subject;
      const existing = byTenant.get(row.tenant.id);
      if (existing && (existing.bound || !bound)) {
        continue;
      }
      byTenant.set(row.tenant.id, {
        bound,
        membership: {
          tenantId: row.tenant.id,
          tenantName: row.tenant.name,
          tenantSlug: row.tenant.slug,
          tenantStatus: row.tenant.status,
          userStatus: row.status,
        },
      });
    }

    return [...byTenant.values()]
      .map((entry) => entry.membership)
      .sort(
        (a, b) =>
          a.tenantName.localeCompare(b.tenantName) ||
          a.tenantId.localeCompare(b.tenantId),
      );
  }

  // The businesses this identity may actually enter right now: an ACTIVE
  // membership in an ACTIVE tenant. This is the Business switcher's source;
  // a suspended tenant or a non-ACTIVE membership is simply absent.
  async listAccessibleBusinesses(
    identity: InternalIdentity,
  ): Promise<InternalBusinessSummary[]> {
    const memberships = await this.findMemberships(identity);
    return memberships.filter(isEnterable).map((membership) => ({
      id: membership.tenantId,
      name: membership.tenantName,
      slug: membership.tenantSlug,
    }));
  }

  // Chooses the request's active tenant. `requestedTenantId` is the
  // client's INTENT (already format-validated by the caller) — it is only
  // ever honoured when it names a business this identity may enter. With no
  // request, a single enterable business is selected implicitly (the
  // ordinary one-business administrator never has to choose).
  async selectActiveTenant(
    identity: InternalIdentity,
    requestedTenantId: string | null,
  ): Promise<ActiveTenantSelection> {
    const enterable = (await this.findMemberships(identity)).filter(
      isEnterable,
    );

    if (requestedTenantId !== null) {
      const match = enterable.find((m) => m.tenantId === requestedTenantId);
      return match
        ? { outcome: 'selected', tenantId: match.tenantId }
        : { outcome: 'denied' };
    }

    if (enterable.length === 1) {
      return { outcome: 'selected', tenantId: enterable[0].tenantId };
    }
    return enterable.length === 0
      ? { outcome: 'denied' }
      : { outcome: 'selection-required' };
  }
}

function isEnterable(membership: InternalTenantMembership): boolean {
  return (
    membership.userStatus === 'ACTIVE' && membership.tenantStatus === 'ACTIVE'
  );
}
