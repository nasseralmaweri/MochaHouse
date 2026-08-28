import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type {
  CustomerProfile,
  CustomerUpdateProfileRequest,
} from '@mocha-house/contracts';
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

  // Milestone 4E — customer edits their own profile. The record is
  // resolved from the *authenticated identity*, never from anything in the
  // request body, so this can only ever update the caller's own Customer.
  // updateProfile writes nothing but displayName; provider identity,
  // account status, email, and verification state are untouchable here.
  @UseGuards(CustomerAuthGuard)
  @Patch('me')
  async updateMe(
    @Req() request: CustomerAuthenticatedRequest,
    @Body() body: CustomerUpdateProfileRequest,
  ): Promise<CustomerProfile> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    const updated = await this.customersService.updateProfile(
      customer.id,
      body,
    );
    return this.customersService.toProfile(updated);
  }
}
