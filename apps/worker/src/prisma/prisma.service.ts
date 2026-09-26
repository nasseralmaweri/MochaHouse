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

    // Milestone S0C — the report-only tenant query audit; identical to
    // apps/api's PrismaService (observer only, never alters or blocks a
    // query; TENANT_QUERY_AUDIT=off disables it).
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
