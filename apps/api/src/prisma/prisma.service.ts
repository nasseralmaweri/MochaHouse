import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  parseTenantQueryAuditMode,
  tenantQueryAuditExtension,
} from '@mocha-house/database';

const auditLogger = new Logger('TenantQueryAudit');

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });

    super({ adapter });

    // Milestone S0C — the report-only tenant query audit (see
    // tenantQueryAuditExtension). An observer only: it never alters, adds
    // to or blocks a query, and never supplies a tenant id. It logs each
    // distinct unguarded (model, operation, context) signature once, at
    // debug level, to build the S0D/S0E conversion baseline.
    // TENANT_QUERY_AUDIT=off disables it; an invalid value fails startup.
    //
    // Returning the extended client from the constructor keeps every
    // existing `PrismaService` injection site and type unchanged, while
    // routing their queries (including interactive transactions) through
    // the observer. The returned object still exposes onModuleInit /
    // onModuleDestroy and every client method; only `instanceof
    // PrismaService` is false (nothing in the codebase relies on it).
    if (
      parseTenantQueryAuditMode(process.env.TENANT_QUERY_AUDIT) === 'report'
    ) {
      return this.$extends(
        tenantQueryAuditExtension({
          onFirstObservation: (observation) =>
            auditLogger.debug(JSON.stringify(observation)),
        }),
      ) as unknown as PrismaService;
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
