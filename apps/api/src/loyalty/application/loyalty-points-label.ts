import {
  DEFAULT_LOYALTY_POINTS_LABEL,
  LOYALTY_POINTS_LABEL_MAX,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import type { LegacyBrand } from '../../tenancy/legacy-brand';
import { LOYALTY_CONFIGURATION_KEY } from './loyalty.service';

// SC4f-3b — the name a business shows for its loyalty points. Presentation
// only: balances, earning, redemption and every API amount are unchanged.
//   * the business's own label (LoyaltyConfiguration.pointsLabel), else
//   * "Mocha Beans" for the legacy business (identified by trusted
//     configuration — see tenancy/legacy-brand.ts), so its established name
//     is kept without any data change, else
//   * "Points".

export const LEGACY_POINTS_LABEL = 'Mocha Beans';

export async function effectivePointsLabel(
  db: Pick<PrismaService, 'loyaltyConfiguration'> | Prisma.TransactionClient,
  tenantId: string,
  legacy: LegacyBrand,
): Promise<string> {
  const config = await db.loyaltyConfiguration.findUnique({
    where: { tenantId_key: { tenantId, key: LOYALTY_CONFIGURATION_KEY } },
    select: { pointsLabel: true },
  });
  return resolvePointsLabel(
    config?.pointsLabel ?? null,
    legacy.isLegacy(tenantId),
  );
}

export function resolvePointsLabel(
  configured: string | null,
  isLegacy: boolean,
): string {
  if (configured) return configured;
  return isLegacy ? LEGACY_POINTS_LABEL : DEFAULT_LOYALTY_POINTS_LABEL;
}

export class PointsLabelError extends Error {}

// A submitted label: trimmed, inner whitespace collapsed; blank or null
// restores the default (stored as null). Letters, digits, spaces and
// simple punctuation only, up to LOYALTY_POINTS_LABEL_MAX characters.
export function normalizePointsLabel(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new PointsLabelError('pointsLabel must be text or null.');
  }
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label === '') return null;
  if (
    label.length > LOYALTY_POINTS_LABEL_MAX ||
    !/^[\p{L}\p{N}][\p{L}\p{N} '&.-]*$/u.test(label)
  ) {
    throw new PointsLabelError(
      `Use up to ${LOYALTY_POINTS_LABEL_MAX} letters, numbers, spaces or simple punctuation.`,
    );
  }
  return label;
}
