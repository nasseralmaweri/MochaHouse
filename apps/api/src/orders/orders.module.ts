import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { OrdersController } from './api/orders.controller';
import { CheckoutRewardsController } from './api/checkout-rewards.controller';
import { AdminOrdersController } from './api/admin-orders.controller';
import { CustomerOrdersController } from './api/customer-orders.controller';
import { CheckoutService } from './application/checkout.service';
import { AdminOrdersService } from './application/admin-orders.service';
import { CustomerOrdersService } from './application/customer-orders.service';
import { CustomerReorderService } from './application/customer-reorder.service';

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
  imports: [
    PrismaModule,
    LocationsModule,
    CustomersModule,
    LoyaltyModule,
    PromotionsModule,
    GiftCardsModule,
    // The payment boundary binding (Milestone 7H) — CheckoutService depends
    // only on the PaymentProvider interface via PAYMENT_PROVIDER.
    PaymentModule,
  ],
  controllers: [
    OrdersController,
    CheckoutRewardsController,
    AdminOrdersController,
    CustomerOrdersController,
  ],
  providers: [
    CheckoutService,
    AdminOrdersService,
    CustomerOrdersService,
    CustomerReorderService,
  ],
  // PaymentModule — re-exported so the Milestone 5G platform-status read
  // keeps reaching the payment-integration posture through OrdersModule
  // unchanged. CustomerOrdersService — exported (Milestone 8A) so CrmModule
  // can project a customer's order history into the HQ CRM view; it reads
  // the same authoritative Order table, customerId-scoped and read-only.
  exports: [PaymentModule, CustomerOrdersService],
})
export class OrdersModule {}
