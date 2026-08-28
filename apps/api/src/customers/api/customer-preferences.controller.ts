import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type {
  CustomerCommunicationPreferences,
  CustomerUpdateCommunicationPreferencesRequest,
} from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../application/customers.service';
import { CustomerPreferencesService } from '../application/customer-preferences.service';

// Authenticated, customer-owned communication-preferences surface
// (Milestone 4F). Identity is always the one CustomerAuthGuard verified,
// resolved to a Mocha House Customer — never taken from the request.
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/customers/me/preferences')
export class CustomerPreferencesController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly preferencesService: CustomerPreferencesService,
  ) {}

  @Get()
  async get(
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerCommunicationPreferences> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.preferencesService.getForCustomer(customer.id);
  }

  @Patch()
  async update(
    @Req() request: CustomerAuthenticatedRequest,
    @Body() body: CustomerUpdateCommunicationPreferencesRequest,
  ): Promise<CustomerCommunicationPreferences> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.preferencesService.updateForCustomer(customer.id, body);
  }
}
