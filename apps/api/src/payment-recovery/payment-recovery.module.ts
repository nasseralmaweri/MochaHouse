import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PaymentRecoveryService } from './application/payment-recovery.service';
import { PlatformPaymentCasesService } from './application/platform-payment-cases.service';
import { PlatformPaymentCasesController } from './api/platform-payment-cases.controller';

// ESP-03 PR 5 — payment reconciliation and automatic recovery (sweeper OFF
// unless PAYMENT_AUTO_RECOVERY_ENABLED=1), and its Platform Console support
// routes.
@Module({
  imports: [
    PrismaModule,
    OrdersModule,
    GiftCardsModule,
    PlatformAuthModule,
    RateLimitModule,
  ],
  controllers: [PlatformPaymentCasesController],
  providers: [PaymentRecoveryService, PlatformPaymentCasesService],
  exports: [PaymentRecoveryService],
})
export class PaymentRecoveryModule {}
