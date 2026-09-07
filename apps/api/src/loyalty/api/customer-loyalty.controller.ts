import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { CustomerLoyaltySummary } from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../../customers/application/customers.service';
import { LoyaltyService } from '../application/loyalty.service';
import { LoyaltyRewardsService } from '../application/loyalty-rewards.service';

// The customer's own Mocha Beans view (Milestone 7A balance; Milestone 7B
// adds the Rewards Catalog). Authenticated (mandatory — see
// CustomerAuthGuard) and scoped strictly to the caller's own Customer id,
// resolved from the verified identity exactly like GET /customers/me. Never
// accepts a customerId from the request.
//
// Read-only: customer-facing Bean history stays off, and NOTHING here lets
// a customer select, reserve, apply or redeem a reward — no Beans move.
// `rewards` is the currently ACTIVE catalog only, in HQ display order, each
// annotated with `canAfford` (informational).
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/customers/me/loyalty')
export class CustomerLoyaltyController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly loyaltyService: LoyaltyService,
    private readonly rewardsService: LoyaltyRewardsService,
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
    const rewards =
      await this.rewardsService.listActiveRewardsForCustomer(balance);
    return { balance, rewards };
  }
}
