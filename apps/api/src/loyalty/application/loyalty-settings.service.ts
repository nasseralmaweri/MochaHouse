import { BadRequestException, Injectable } from '@nestjs/common';
import type { LoyaltySettings } from '@mocha-house/contracts';
import { DEFAULT_MOCHA_BEANS_PER_DOLLAR } from '@mocha-house/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { LOYALTY_CONFIGURATION_KEY } from './loyalty.service';

// HQ configuration of the standard company-wide Mocha Bean earning rate
// (Milestone 7B). `loyalty.configure` is CORPORATE-only in the permission
// catalog — PermissionGuard already rejects a LOCATION grant, and every
// method here also calls `assertCorporate`.
//
// The configuration is a keyed singleton (key "company"). It is seeded, but
// this service also lazily upserts it so a fresh database or a test that
// skips the seed still reads a safe default (1 Bean / $1 — the 7A
// behaviour).

const MIN_EARNING_RATE = 1;
const MAX_EARNING_RATE = 100;

@Injectable()
export class LoyaltySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async getSettings(
    authorization: AuthorizationContext,
  ): Promise<LoyaltySettings> {
    authorization.assertCorporate('loyalty.configure');
    const config = await this.ensureConfiguration();
    return { earningRatePerDollar: config.earningRatePerDollar };
  }

  // Reads the current rate without an authorization check — for the earn
  // path and the customer surface, which have their own gating.
  async getEarningRatePerDollar(): Promise<number> {
    const config = await this.prisma.loyaltyConfiguration.findUnique({
      where: { key: LOYALTY_CONFIGURATION_KEY },
      select: { earningRatePerDollar: true },
    });
    return config?.earningRatePerDollar ?? DEFAULT_MOCHA_BEANS_PER_DOLLAR;
  }

  async updateEarningRate(
    rawRate: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<LoyaltySettings> {
    authorization.assertCorporate('loyalty.configure');

    const afterRate = this.validateRate(rawRate);
    const current = await this.ensureConfiguration();

    if (current.earningRatePerDollar === afterRate) {
      // No-op — nothing to change, nothing to audit.
      return { earningRatePerDollar: current.earningRatePerDollar };
    }

    await this.prisma.$transaction(async (tx) => {
      // Update by the stable key so this is safe even if two requests race:
      // updateMany on the unique key, then re-read.
      await tx.loyaltyConfiguration.update({
        where: { key: LOYALTY_CONFIGURATION_KEY },
        data: { earningRatePerDollar: afterRate },
      });
      await this.audit.recordLoyaltyEarningRateChanged(tx, {
        actorInternalUserId,
        beforeRatePerDollar: current.earningRatePerDollar,
        afterRatePerDollar: afterRate,
      });
    });

    return { earningRatePerDollar: afterRate };
  }

  private async ensureConfiguration(): Promise<{
    earningRatePerDollar: number;
  }> {
    return this.prisma.loyaltyConfiguration.upsert({
      where: { key: LOYALTY_CONFIGURATION_KEY },
      create: { key: LOYALTY_CONFIGURATION_KEY },
      update: {},
      select: { earningRatePerDollar: true },
    });
  }

  private validateRate(raw: unknown): number {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < MIN_EARNING_RATE ||
      raw > MAX_EARNING_RATE
    ) {
      throw new BadRequestException(
        `The earning rate must be a whole number between ${MIN_EARNING_RATE} and ${MAX_EARNING_RATE} Mocha Beans per dollar.`,
      );
    }
    return raw;
  }
}
