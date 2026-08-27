import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type {
  CustomerOrderDetail,
  CustomerOrderSummary,
} from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CustomersService } from '../../customers/application/customers.service';
import { CustomerOrdersService } from '../application/customer-orders.service';

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
}
