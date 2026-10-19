import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { AuditModule } from '../audit/audit.module';
import { AdminPaymentsController } from './api/admin-payments.controller';
import { ConnectWebhookController } from './api/connect-webhook.controller';
import { PaymentAccountsService } from './application/payment-accounts.service';
import { CONNECT_ACCOUNT_PROVIDER } from './provider/connect-account-provider';
import { createConnectAccountProvider } from './provider/connect-provider-mode';

// ESP-04 M1 — restaurant customer payments, connected accounts only (Stripe
// Connect foundation). Deliberately separate from SaasBillingModule
// (CENTERIVO's own subscription billing) and from PaymentModule (the
// checkout's payment provider): no shared provider, configuration, webhook or
// table. Nothing here can take a customer payment.
@Module({
  imports: [PrismaModule, InternalAuthModule, RateLimitModule, AuditModule],
  controllers: [AdminPaymentsController, ConnectWebhookController],
  providers: [
    PaymentAccountsService,
    {
      provide: CONNECT_ACCOUNT_PROVIDER,
      useFactory: () => createConnectAccountProvider(),
    },
  ],
  exports: [PaymentAccountsService],
})
export class RestaurantPaymentsModule {}
