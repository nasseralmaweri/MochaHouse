import { Module } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import { PrismaModule } from '../prisma/prisma.module';
import { LocationsModule } from '../locations/locations.module';
import { OrdersController } from './api/orders.controller';
import { CheckoutService } from './application/checkout.service';
import { PAYMENT_PROVIDER } from './infrastructure/payment-provider.token';

@Module({
  imports: [PrismaModule, LocationsModule],
  controllers: [OrdersController],
  providers: [
    CheckoutService,
    // FakePaymentProvider is the only binding here — CheckoutService only
    // ever depends on the PaymentProvider interface, so a real processor
    // is a one-line swap in this provider list, not an orchestration change.
    { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
  ],
})
export class OrdersModule {}
