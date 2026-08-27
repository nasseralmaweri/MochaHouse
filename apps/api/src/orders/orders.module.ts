import { Module } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import { PrismaModule } from '../prisma/prisma.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersController } from './api/orders.controller';
import { AdminOrdersController } from './api/admin-orders.controller';
import { CustomerOrdersController } from './api/customer-orders.controller';
import { CheckoutService } from './application/checkout.service';
import { AdminOrdersService } from './application/admin-orders.service';
import { CustomerOrdersService } from './application/customer-orders.service';
import { PAYMENT_PROVIDER } from './infrastructure/payment-provider.token';
import { DevInternalGuard } from './infrastructure/dev-internal.guard';

// apps/api stays synchronous request/response only — OutboxEvent rows are
// written here (see CheckoutService) and read here (see
// AdminOrdersService), but claiming/processing them is apps/worker's job
// (see apps/worker/src/outbox). No polling loop runs in this process.
//
// CustomersModule is imported for CustomersService: checkout resolves an
// optionally-authenticated identity to a Customer id (Milestone 4B), and
// CustomerOrdersController does the same to scope its queries — neither
// duplicates that resolution logic.
@Module({
  imports: [PrismaModule, LocationsModule, CustomersModule],
  controllers: [
    OrdersController,
    AdminOrdersController,
    CustomerOrdersController,
  ],
  providers: [
    CheckoutService,
    AdminOrdersService,
    CustomerOrdersService,
    // FakePaymentProvider is the only binding here — CheckoutService only
    // ever depends on the PaymentProvider interface, so a real processor
    // is a one-line swap in this provider list, not an orchestration change.
    { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
    DevInternalGuard,
  ],
})
export class OrdersModule {}
