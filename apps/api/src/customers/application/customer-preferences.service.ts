import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CustomerCommunicationPreferences,
  CustomerUpdateCommunicationPreferencesRequest,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

// Milestone 4F — the customer's communication preferences. Scope for this
// slice is exactly one boolean: marketingEmailOptIn. It is Mocha House
// application data (never written back to Cognito) and never gates
// transactional/account email. Every method takes the Customer.id the
// caller resolved from the verified identity.
@Injectable()
export class CustomerPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async getForCustomer(
    customerId: string,
  ): Promise<CustomerCommunicationPreferences> {
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { marketingEmailOptIn: true },
    });
    return { marketingEmailOptIn: customer.marketingEmailOptIn };
  }

  async updateForCustomer(
    customerId: string,
    request: CustomerUpdateCommunicationPreferencesRequest,
  ): Promise<CustomerCommunicationPreferences> {
    // Strict boolean — a truthy string / 0 / 1 / missing field is a bad
    // request, never coerced.
    if (typeof request?.marketingEmailOptIn !== 'boolean') {
      throw new BadRequestException('marketingEmailOptIn must be a boolean.');
    }

    // Only this column is ever in `data`: identity, status, email, and
    // verification state are structurally untouchable here. Unknown request
    // fields are ignored.
    const customer = await this.prisma.customer.update({
      where: { id: customerId },
      data: { marketingEmailOptIn: request.marketingEmailOptIn },
      select: { marketingEmailOptIn: true },
    });
    return { marketingEmailOptIn: customer.marketingEmailOptIn };
  }
}
