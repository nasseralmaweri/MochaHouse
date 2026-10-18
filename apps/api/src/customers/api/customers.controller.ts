import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  CustomerEnrollmentRequest,
  CustomerEnrollmentResponse,
  CustomerProfile,
  CustomerUpdateProfileRequest,
} from '@mocha-house/contracts';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { CustomersService } from '../application/customers.service';

@Controller('api/v1/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @UseGuards(CustomerAuthGuard)
  @Get('me')
  async me(
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<CustomerProfile> {
    // CustomerAuthGuard always sets this before a request reaches here.
    // SC4f-2: never creates a profile; every account status may read its
    // own profile, so a limited customer can be told why.
    const customer = await this.customersService.requireCustomer(
      request.customerIdentity!,
      tenant,
      'profile',
    );
    return this.customersService.toProfile(customer);
  }

  // SC4f-2 — the customer's explicit choice to join THIS business (the one
  // the request was resolved to; nothing in the body names a business).
  // Idempotent: 201 when a profile was created, 200 when this login already
  // had one here (returned unchanged). Browser calls arrive only through
  // the web app's same-origin proxy, which applies the CSRF check.
  @UseGuards(CustomerAuthGuard, RateLimitGuard)
  @RateLimit('customer-enrollment')
  @Post('me/enrollment')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async enroll(
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Body() body: CustomerEnrollmentRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerEnrollmentResponse> {
    const { customer, created } = await this.customersService.enroll(
      request.customerIdentity!,
      tenant,
      body,
    );
    if (created) response.status(HttpStatus.CREATED);
    return { profile: this.customersService.toProfile(customer), created };
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
    @CurrentTenantContext() tenant: TenantContext,
    @Body() body: CustomerUpdateProfileRequest,
  ): Promise<CustomerProfile> {
    const customer = await this.customersService.requireCustomer(
      request.customerIdentity!,
      tenant,
      'write',
    );
    const updated = await this.customersService.updateProfile(
      customer.id,
      body,
    );
    return this.customersService.toProfile(updated);
  }
}
