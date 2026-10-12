import { BadRequestException, Injectable } from '@nestjs/common';
import {
  GIFT_CARD_CUSTOM_MAX_MINOR_UNITS,
  GIFT_CARD_CUSTOM_MIN_MINOR_UNITS,
  GIFT_CARD_MAX_VALUE_MINOR_UNITS,
  type GiftCardConfiguration,
  type GiftCardPurchaseOptions,
  type UpdateGiftCardConfigurationRequest,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type { TenantContext } from '@mocha-house/database';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// HQ configuration of gift-card purchasing (Milestone 7F). Persisted now so
// the FUTURE customer-purchasing slice has HQ settings to read — nothing in
// 7F consumes it. `giftcards.configure` is CORPORATE-only in the permission
// catalog (PermissionGuard rejects a LOCATION grant); every method also
// calls `assertCorporate`.
//
// The configuration is a keyed singleton (key "company"), mirroring
// LoyaltyConfiguration. It is seeded, and this service also lazily upserts
// it so a fresh database or a test that skips the seed still reads safe
// defaults.

export const GIFT_CARD_CONFIGURATION_KEY = 'company';

const DEFAULT_PRESET_AMOUNTS_MINOR_UNITS = [1000, 2500, 5000, 10000];
const MAX_PRESET_COUNT = 12;

@Injectable()
export class GiftCardConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async getConfiguration(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<GiftCardConfiguration> {
    authorization.assertCorporate('giftcards.configure');
    const config = await this.ensureConfiguration(tenant);
    return {
      presetAmountsMinorUnits: config.presetAmountsMinorUnits,
      customAmountEnabled: config.customAmountEnabled,
    };
  }

  // Milestone 7H — the PUBLIC read for the customer purchase page. No
  // authorization: it exposes only the amount rules a buyer needs (presets,
  // whether custom is allowed, the fixed custom bounds, currency) and no
  // internal configuration metadata.
  //
  // READ-ONLY (post-review correction D): an anonymous GET must never write.
  // If the singleton row does not exist yet it returns the same safe
  // defaults in memory WITHOUT persisting them — an authorised HQ write path
  // (getConfiguration / updateConfiguration) creates the row when needed.
  //
  // Each business has its own configuration, keyed (tenantId, key).
  async getPublicOptions(
    tenant: TenantContext,
  ): Promise<GiftCardPurchaseOptions> {
    const config = await this.prisma.giftCardConfiguration.findUnique({
      where: {
        tenantId_key: {
          tenantId: tenant.tenantId,
          key: GIFT_CARD_CONFIGURATION_KEY,
        },
      },
      select: { presetAmountsMinorUnits: true, customAmountEnabled: true },
    });
    return {
      presetAmountsMinorUnits:
        config?.presetAmountsMinorUnits ?? DEFAULT_PRESET_AMOUNTS_MINOR_UNITS,
      customAmountEnabled: config?.customAmountEnabled ?? true,
      customAmountMinMinorUnits: GIFT_CARD_CUSTOM_MIN_MINOR_UNITS,
      customAmountMaxMinorUnits: GIFT_CARD_CUSTOM_MAX_MINOR_UNITS,
      currency: 'USD',
    };
  }

  async updateConfiguration(
    request: UpdateGiftCardConfigurationRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<GiftCardConfiguration> {
    authorization.assertCorporate('giftcards.configure');

    const presetAmountsMinorUnits = this.validatePresets(
      request?.presetAmountsMinorUnits,
    );
    const customAmountEnabled = this.validateCustomAmountEnabled(
      request?.customAmountEnabled,
    );

    const current = await this.ensureConfiguration(tenant);
    const before = {
      presetAmountsMinorUnits: current.presetAmountsMinorUnits,
      customAmountEnabled: current.customAmountEnabled,
    };
    const after = { presetAmountsMinorUnits, customAmountEnabled };

    if (
      before.customAmountEnabled === after.customAmountEnabled &&
      arraysEqual(before.presetAmountsMinorUnits, after.presetAmountsMinorUnits)
    ) {
      // No-op — nothing to change, nothing to audit.
      return after;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.giftCardConfiguration.update({
        where: {
          tenantId_key: {
            tenantId: tenant.tenantId,
            key: GIFT_CARD_CONFIGURATION_KEY,
          },
        },
        data: after,
      });
      await this.audit.recordGiftCardConfigurationUpdated(tx, {
        actorInternalUserId,
        before,
        after,
      });
    });

    return after;
  }

  // The active business's own configuration row, created on first use.
  private async ensureConfiguration(tenant: TenantContext): Promise<{
    presetAmountsMinorUnits: number[];
    customAmountEnabled: boolean;
  }> {
    return this.prisma.giftCardConfiguration.upsert({
      where: {
        tenantId_key: {
          tenantId: tenant.tenantId,
          key: GIFT_CARD_CONFIGURATION_KEY,
        },
      },
      create: {
        tenantId: tenant.tenantId,
        key: GIFT_CARD_CONFIGURATION_KEY,
        presetAmountsMinorUnits: DEFAULT_PRESET_AMOUNTS_MINOR_UNITS,
        customAmountEnabled: true,
      },
      update: {},
      select: { presetAmountsMinorUnits: true, customAmountEnabled: true },
    });
  }

  private validatePresets(raw: unknown): number[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException(
        'Provide at least one preset purchase amount.',
      );
    }
    if (raw.length > MAX_PRESET_COUNT) {
      throw new BadRequestException(
        `Provide at most ${MAX_PRESET_COUNT} preset purchase amounts.`,
      );
    }
    const seen = new Set<number>();
    for (const value of raw) {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value <= 0 ||
        value > GIFT_CARD_MAX_VALUE_MINOR_UNITS
      ) {
        throw new BadRequestException(
          `Each preset amount must be a whole number of minor units between 1 and ${GIFT_CARD_MAX_VALUE_MINOR_UNITS} ($2,000.00).`,
        );
      }
      if (seen.has(value)) {
        throw new BadRequestException('Preset amounts must not repeat.');
      }
      seen.add(value);
    }
    // Store ascending regardless of the order supplied.
    return [...seen].sort((a, b) => a - b);
  }

  private validateCustomAmountEnabled(raw: unknown): boolean {
    if (typeof raw !== 'boolean') {
      throw new BadRequestException(
        'customAmountEnabled must be true or false.',
      );
    }
    return raw;
  }
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
