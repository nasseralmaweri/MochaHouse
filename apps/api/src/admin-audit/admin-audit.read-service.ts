import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import type {
  AdminAuditEventPage,
  AdminAuditEventSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  ACTIVITY_TYPE_TO_ACTION,
  isAdminAuditActivityType,
  projectAuditEvent,
  type RawAuditEvent,
} from './audit-presentation';

// Read-only Admin Activity Log (Milestone 5F). Reads the SAME
// InternalAuditEvent table the 5E write side records into — it is not a
// second audit architecture and it never writes.
//
// The response is constructed field by field from a deliberately narrow
// projection: this service never returns a raw audit row, never returns
// `beforeData` / `afterData`, and never returns a raw `action`,
// `targetType`, or any UUID other than the opaque event id and actor id.
// A future audit payload carrying additional internal data therefore
// cannot leak through — only fields this code explicitly builds are
// returned.

const PAGE_SIZE = 25;
const ACTOR_QUERY_MAX_LENGTH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface AdminAuditListQuery {
  cursor?: string;
  type?: string;
  from?: string;
  to?: string;
  actor?: string;
}

@Injectable()
export class AdminAuditReadService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: AdminAuditListQuery,
    authorization: AuthorizationContext,
  ): Promise<AdminAuditEventPage> {
    // `audit.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the matching
    // service-layer defense.
    authorization.assertCorporate('audit.view');

    const where = this.buildWhere(query);

    // Fetch one extra row to know whether an older page exists without a
    // second query.
    const rows = await this.prisma.internalAuditEvent.findMany({
      where,
      orderBy: { id: 'desc' },
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        action: true,
        createdAt: true,
        reason: true,
        beforeData: true,
        afterData: true,
        targetId: true,
        actorInternalUser: {
          select: { id: true, displayName: true, email: true },
        },
      },
    });

    const hasOlder = rows.length > PAGE_SIZE;
    const pageRows = hasOlder ? rows.slice(0, PAGE_SIZE) : rows;

    const subjectLabelById = await this.resolveSubjects(
      pageRows.map((row) => row.targetId),
    );

    const events: AdminAuditEventSummary[] = pageRows.map((row) => {
      const raw: RawAuditEvent = {
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        reason: row.reason,
        beforeData: row.beforeData,
        afterData: row.afterData,
      };
      return projectAuditEvent(raw, {
        actor: {
          id: row.actorInternalUser.id,
          name:
            row.actorInternalUser.displayName ?? row.actorInternalUser.email,
          email: row.actorInternalUser.email,
        },
        subjectLabel: subjectLabelById.get(row.targetId) ?? 'an Admin user',
      });
    });

    return {
      events,
      nextCursor: hasOlder ? pageRows[pageRows.length - 1].id : null,
    };
  }

  private buildWhere(
    query: AdminAuditListQuery,
  ): Prisma.InternalAuditEventWhereInput {
    const where: Prisma.InternalAuditEventWhereInput = {};

    // --- Cursor (forward pagination) ------------------------------
    // Ordering is by `id` descending; `id` is a UUIDv7 stored lower-case, so
    // its lexicographic order matches chronological order. The next page is
    // simply every event with an id strictly less than the cursor.
    if (query.cursor !== undefined) {
      if (!UUID_PATTERN.test(query.cursor)) {
        throw new BadRequestException('The activity log link is not valid.');
      }
      // A syntactically valid cursor that matches no event is treated as a
      // boundary value — you get every event older than that id. No
      // existence check is needed or performed.
      where.id = { lt: query.cursor.toLowerCase() };
    }

    // --- Activity type -------------------------------------------
    if (query.type !== undefined && query.type !== '') {
      if (!isAdminAuditActivityType(query.type)) {
        throw new BadRequestException('That activity type is not recognised.');
      }
      where.action = ACTIVITY_TYPE_TO_ACTION[query.type];
    }

    // --- Date range (both bounds inclusive) ---------------------
    const createdAt = this.buildDateRange(query.from, query.to);
    if (createdAt) {
      where.createdAt = createdAt;
    }

    // --- Performed by (actor name / email substring) -----------
    if (query.actor !== undefined) {
      const actor = query.actor.trim();
      if (actor.length > ACTOR_QUERY_MAX_LENGTH) {
        throw new BadRequestException(
          `Keep the "performed by" search under ${ACTOR_QUERY_MAX_LENGTH} characters.`,
        );
      }
      if (actor.length > 0) {
        where.actorInternalUser = {
          OR: [
            { displayName: { contains: actor, mode: 'insensitive' } },
            { email: { contains: actor, mode: 'insensitive' } },
          ],
        };
      }
    }

    return where;
  }

  private buildDateRange(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.DateTimeFilter | undefined {
    const parsedFrom = this.parseBound(from, 'start');
    const parsedTo = this.parseBound(to, 'end');

    if (parsedFrom && parsedTo && parsedFrom.getTime() > parsedTo.getTime()) {
      throw new BadRequestException(
        'The "from" date must be on or before the "to" date.',
      );
    }

    if (!parsedFrom && !parsedTo) {
      return undefined;
    }
    return {
      ...(parsedFrom ? { gte: parsedFrom } : {}),
      ...(parsedTo ? { lte: parsedTo } : {}),
    };
  }

  // A bare `YYYY-MM-DD` is widened to the whole day (start → 00:00:00.000Z,
  // end → 23:59:59.999Z) so a "to" of today includes everything that
  // happened today. A full timestamp is honoured as given.
  private parseBound(
    value: string | undefined,
    edge: 'start' | 'end',
  ): Date | null {
    if (value === undefined || value.trim() === '') {
      return null;
    }
    const trimmed = value.trim();
    const normalised = DATE_ONLY_PATTERN.test(trimmed)
      ? edge === 'start'
        ? `${trimmed}T00:00:00.000Z`
        : `${trimmed}T23:59:59.999Z`
      : trimmed;
    const parsed = new Date(normalised);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('That date is not valid.');
    }
    return parsed;
  }

  private async resolveSubjects(
    targetIds: string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(targetIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const users = await this.prisma.internalUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, email: true },
    });
    return new Map(
      users.map((user) => [user.id, user.displayName ?? user.email]),
    );
  }
}
