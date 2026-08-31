import { Inject, Injectable } from '@nestjs/common';
import type { PaymentProvider } from '@mocha-house/integrations';
import type { AdminPlatformStatus } from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import { isDevInternalAuthEnabled } from '../internal-auth/infrastructure/internal-auth-provider-mode';
import { isDevCustomerAuthEnabled } from '../customer-auth/infrastructure/auth-provider-mode';
import {
  authenticationModeLabel,
  environmentLabel,
  paymentProviderLabel,
} from './platform-presentation';

// Read-only Admin Platform Status (Milestone 5G). Reports the platform's
// high-level posture from information the application already holds — the
// per-request auth-provider mode, the payment boundary token, and a single
// aggregate query over Location. It never serialises `process.env`, never
// returns a raw configuration object, and constructs every response field
// explicitly. There is no write path.
@Injectable()
export class AdminPlatformStatusService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  async getStatus(
    authorization: AuthorizationContext,
  ): Promise<AdminPlatformStatus> {
    // `platform.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the matching
    // service-layer defense.
    authorization.assertCorporate('platform.view');

    const isProduction = process.env.NODE_ENV === 'production';
    // The FakePaymentProvider names itself "fake"; any real processor
    // reports its own name. We compare the interface's own `name`, never
    // the class.
    const paymentsIsDevelopmentStandIn = this.payments.name === 'fake';

    const locations = await this.prisma.location.findMany({
      select: { isActive: true, isDigitalOrderingEnabled: true },
    });
    const activeLocations = locations.filter((location) => location.isActive);
    const digitalOrderingEnabledCount = activeLocations.filter(
      (location) => location.isDigitalOrderingEnabled,
    ).length;

    return {
      environmentLabel: environmentLabel(isProduction),
      isProduction,
      authentication: {
        adminLabel: authenticationModeLabel(isDevInternalAuthEnabled()),
        customerLabel: authenticationModeLabel(isDevCustomerAuthEnabled()),
      },
      payments: {
        providerLabel: paymentProviderLabel(paymentsIsDevelopmentStandIn),
        isDevelopmentStandIn: paymentsIsDevelopmentStandIn,
      },
      locations: {
        activeCount: activeLocations.length,
        inactiveCount: locations.length - activeLocations.length,
        digitalOrderingEnabledCount,
        digitalOrderingDisabledCount:
          activeLocations.length - digitalOrderingEnabledCount,
      },
    };
  }
}
