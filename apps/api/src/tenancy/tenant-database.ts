import { Injectable } from '@nestjs/common';
import {
  TenantContextError,
  isValidTenantId,
  type TenantContext,
} from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';

// The tenant-aware entry point to the database (S0B ADR-3 / ADR-8).
//
// Services converted in S0E obtain their client HERE, from an explicit
// TenantContext, instead of injecting PrismaService directly. It fails
// closed on a missing or malformed context. In S0C it deliberately returns
// the one shared client and adds no predicates: no existing table has a
// tenantId yet, and pretending otherwise would be false isolation. Its two
// future roles are:
//   - the point where per-model tenant enforcement is switched on (S0E);
//   - the routing hook for a tenant on dedicated infrastructure (ADR-8).
// Nothing calls it yet.
@Injectable()
export class TenantDatabase {
  constructor(private readonly prisma: PrismaService) {}

  forContext(context: TenantContext | undefined): PrismaService {
    if (!context || !isValidTenantId(context.tenantId)) {
      throw new TenantContextError(
        'Database access requires an established TenantContext.',
      );
    }
    return this.prisma;
  }
}
