import { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';

// SC1d — the ONE rule for matching a verified email to staff rows that have
// not been bound to a login yet (externalSubject IS NULL). Shared by sign-in
// (InternalUsersService.resolveForAuthentication) and the business list /
// active-business choice (InternalTenantMembershipService), so the two can
// never disagree.
//
//   - Case-insensitive: LOWER(email) = LOWER(the token's email, trimmed).
//     A plain parameterised equality — deliberately not Prisma's
//     `mode: 'insensitive'`, so `_` and `%` in an address are never
//     wildcards.
//   - Same identity provider only, unbound rows only. Rows already bound to
//     a login are matched by subject elsewhere and never by email.
//   - The caller has already required a VERIFIED email (Security 4A).
//   - Per business: exactly one match binds. Two or more rows in the same
//     business that differ only by letter case are AMBIGUOUS: nothing is
//     bound and that business is not entered (fail closed). Rows are never
//     merged, overwritten or reassigned.
//
// The (tenantId, email) unique key is case-sensitive, so such case-only
// duplicates can exist in data created before SC1d; this is what keeps them
// safe.

export interface UnboundEmailMatch {
  id: string;
  tenantId: string;
}

// Caps the read. A result that reaches the cap is treated as ambiguous for
// every business (nothing matches): a cut-off can never make a business
// look unambiguous. Unrealistic in practice.
const MATCH_LIMIT = 500;

export async function findUnboundEmailMatches(
  prisma: PrismaService,
  provider: string,
  email: string,
  tenantId: string | null,
): Promise<UnboundEmailMatch[]> {
  const address = email.trim();
  if (address.length === 0) return [];
  const rows = await prisma.$queryRaw<UnboundEmailMatch[]>(Prisma.sql`
    SELECT "id", "tenantId"
    FROM "InternalUser"
    WHERE "externalProvider" = ${provider}
      AND "externalSubject" IS NULL
      AND LOWER("email") = LOWER(${address})
      ${tenantId === null ? Prisma.empty : Prisma.sql`AND "tenantId" = ${tenantId}`}
    ORDER BY "tenantId", "id"
    LIMIT ${MATCH_LIMIT}
  `);
  return rows.length >= MATCH_LIMIT ? [] : rows;
}

// Groups matches by business and keeps only the unambiguous ones: the
// business id -> the single matching row id.
export function unambiguousByTenant(
  matches: readonly UnboundEmailMatch[],
): Map<string, string> {
  const counts = new Map<string, { id: string; count: number }>();
  for (const match of matches) {
    const entry = counts.get(match.tenantId);
    counts.set(match.tenantId, {
      id: entry?.id ?? match.id,
      count: (entry?.count ?? 0) + 1,
    });
  }
  const result = new Map<string, string>();
  for (const [tenantId, entry] of counts) {
    if (entry.count === 1) result.set(tenantId, entry.id);
  }
  return result;
}
