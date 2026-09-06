import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { CustomerLoyaltySummary } from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../../customers/application/customers.service';
import { LoyaltyService } from '../application/loyalty.service';

// The customer's own Mocha Bean balance (Milestone 7A). Authenticated
// (mandatory — see CustomerAuthGuard) and scoped strictly to the caller's
// own Customer id, resolved from the verified identity exactly like
// GET /customers/me. Never accepts a customerId from the request.
//
// Deliberately balance-only: customer-facing Bean history is an
// HQ-controlled setting that defaults off and ships later, and there is no
// rewards data yet.
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/customers/me/loyalty')
export class CustomerLoyaltyController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  @Get()
  async getSummary(
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerLoyaltySummary> {
    // CustomerAuthGuard always sets this before a request reaches here.
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    const balance = await this.loyaltyService.getBalanceForCustomer(
      customer.id,
    );
    return { balance };
  }
}
