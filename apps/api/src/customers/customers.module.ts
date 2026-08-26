import { Module } from '@nestjs/common';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomersController } from './api/customers.controller';
import { CustomersService } from './application/customers.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
