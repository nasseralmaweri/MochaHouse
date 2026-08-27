import { Module } from '@nestjs/common';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomersController } from './api/customers.controller';
import { CustomersService } from './application/customers.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  // Needed by OrdersModule: checkout resolves an authenticated identity to
  // a Customer id (Milestone 4B), and the customer order-history endpoints
  // do the same to scope their queries.
  exports: [CustomersService],
})
export class CustomersModule {}
