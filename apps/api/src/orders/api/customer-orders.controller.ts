import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CustomerOrderDetail,
  CustomerOrderSummary,
  ReorderPreparation,
} from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../../customers/application/customers.service';
import { CustomerOrdersService } from '../application/customer-orders.service';
import { CustomerReorderService } from '../application/customer-reorder.service';

// Authenticated (mandatory — see CustomerAuthGuard) order-history surface,
// scoped strictly to the caller's own Mocha House Customer id. Never
// accepts a customerId from the request itself; the only identity this
// controller trusts is the one CustomerAuthGuard verified.
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/customers/me/orders')
export class CustomerOrdersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly customerOrdersService: CustomerOrdersService,
    private readonly customerReorderService: CustomerReorderService,
  ) {}

  @Get()
  async list(
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerOrderSummary[]> {
    // CustomerAuthGuard always sets this before a request reaches here.
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.customerOrdersService.listForCustomer(customer.id);
  }

  @Get(':orderId')
  async detail(
    @Param('orderId') orderId: string,
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<CustomerOrderDetail> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.customerOrdersService.getDetail(customer.id, orderId);
  }

  // Milestone 4G — PREPARE (not place) a reorder. Despite being POST this
  // creates nothing: it revalidates the customer-owned historical order
  // against the current menu and returns a ReorderPreparation for the web
  // layer to turn into a cart. 200, not 201 — no resource is created.
  // A non-owned or nonexistent orderId yields the same 404 as GET :orderId.
  @Post(':orderId/reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(
    @Param('orderId') orderId: string,
    @Req() request: CustomerAuthenticatedRequest,
  ): Promise<ReorderPreparation> {
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      request.customerIdentity!,
    );
    return this.customerReorderService.prepare(customer.id, orderId);
  }
}
