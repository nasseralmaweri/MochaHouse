import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AddPreferredLocationRequest,
  CustomerPreferredLocationsResponse,
} from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { CustomersService } from '../application/customers.service';
import { CustomerPreferredLocationsService } from '../application/customer-preferred-locations.service';

// Authenticated, customer-owned preferred-locations surface (Milestone 4F).
// The customer is ALWAYS the one CustomerAuthGuard verified, resolved to a
// Mocha House Customer — never a customerId from the path or body. Every
// response is the customer's current preferred set (LocationSummary[]).
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/customers/me/locations')
export class CustomerPreferredLocationsController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly preferredLocationsService: CustomerPreferredLocationsService,
  ) {}

  @Get()
  async list(
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
      tenant,
    );
    return this.preferredLocationsService.listForCustomer(customer.id);
  }

  @Post()
  async add(
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Body() body: AddPreferredLocationRequest,
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
      tenant,
    );
    const locationId =
      typeof body?.locationId === 'string' ? body.locationId.trim() : '';
    return this.preferredLocationsService.addForCustomer(
      customer,
      locationId,
      tenant,
    );
  }

  @Delete(':locationId')
  async remove(
    @Param('locationId') locationId: string,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
      tenant,
    );
    return this.preferredLocationsService.removeForCustomer(
      customer.id,
      locationId,
    );
  }
}
