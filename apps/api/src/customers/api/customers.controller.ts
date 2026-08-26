import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { CustomerProfile } from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../application/customers.service';

@Controller('api/v1/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @UseGuards(CustomerAuthGuard)
  @Get('me')
  async me(
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerProfile> {
    // CustomerAuthGuard always sets this before a request reaches here.
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.customersService.toProfile(customer);
  }
}
