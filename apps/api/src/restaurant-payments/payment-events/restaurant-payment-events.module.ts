import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { OrdersModule } from '../../orders/orders.module';
import { PaymentModule } from '../../payment/payment.module';
import { PaymentEventsController } from './payment-events.controller';
import { PaymentEventsService } from './payment-events.service';

// ESP-04 M3 — Stripe payment events (B1: their own endpoint and secret). Its
// own module because it needs both the checkout (to settle a payment and
// create its order exactly once) and the payment provider; the M1
// RestaurantPaymentsModule (connected accounts) stays free of either.
@Module({
  imports: [PrismaModule, RateLimitModule, OrdersModule, PaymentModule],
  controllers: [PaymentEventsController],
  providers: [PaymentEventsService],
})
export class RestaurantPaymentEventsModule {}
