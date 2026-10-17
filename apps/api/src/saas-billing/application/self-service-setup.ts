import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import { awaitingFirstAuthorization } from '../domain/payment-setup';

// SC4b/SC4c — the ONE test for "a business its owner created that has not
// completed its first payment setup": a BILLED subscription the provider
// has never activated (no trial started, no paid period), of a business an
// owner registration created. The registration is read only for a
// never-activated BILLED subscription (rare). Operator-created or -billed,
// complimentary and Founding businesses are never in this state.
export async function isSelfServiceSetupPending(
  db: Prisma.TransactionClient | PrismaService,
  tenantId: string,
  row: {
    billingMode: 'BILLED' | 'COMPLIMENTARY';
    trialStartedAt: Date | null;
    currentPeriodStart: Date | null;
  },
): Promise<boolean> {
  if (!awaitingFirstAuthorization(row)) return false;
  return (
    (await db.ownerRegistration.count({
      where: { provisionedTenantId: tenantId },
    })) > 0
  );
}
