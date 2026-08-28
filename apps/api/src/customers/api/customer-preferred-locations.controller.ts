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
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.preferredLocationsService.listForCustomer(customer.id);
  }

  @Post()
  async add(
    @Req() request: CustomerAuthenticatedRequest,
    @Body() body: AddPreferredLocationRequest,
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    const locationId =
      typeof body?.locationId === 'string' ? body.locationId.trim() : '';
    return this.preferredLocationsService.addForCustomer(
      customer.id,
      locationId,
    );
  }

  @Delete(':locationId')
  async remove(
    @Param('locationId') locationId: string,
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerPreferredLocationsResponse> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.preferredLocationsService.removeForCustomer(
      customer.id,
      locationId,
    );
  }
}
