import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminAdjustMochaBeansRequest,
  AdminLoyaltyCustomer,
  AdminLoyaltyCustomerDetail,
  AdminLoyaltyCustomerSearchResponse,
  AdminMochaBeanLedgerEntry,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { LoyaltyService, isUniqueConstraintViolation } from './loyalty.service';

// The smallest HQ surface over the Mocha Bean ledger (Milestone 7A): find a
// customer, read their balance + the internal ledger, and manually
// add/deduct Beans. Deliberately NOT a customer-management module — it only
// ever touches loyalty data.
//
// `loyalty.view` / `loyalty.adjust` are CORPORATE-only in the permission
// catalog (PermissionGuard already rejects a LOCATION grant); every method
// also calls `assertCorporate` as the matching service-layer defence.

const REASON_MAX_LENGTH = 1000;
const OPERATION_KEY_MIN_LENGTH = 8;
const OPERATION_KEY_MAX_LENGTH = 200;
const SEARCH_LIMIT = 20;
const LEDGER_PAGE_SIZE = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LoyaltyAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loyaltyService: LoyaltyService,
    private readonly audit: InternalAuditService,
  ) {}

  // Narrow lookup: an exact customer-id match OR an exact (case-insensitive)
  // email match. No fuzzy search and no "list everyone" — HQ arrives here
  // already knowing which customer they mean.
  async searchCustomers(
    rawQuery: string | undefined,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyCustomerSearchResponse> {
    authorization.assertCorporate('loyalty.view');

    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (query.length === 0) {
      throw new BadRequestException(
        'Enter a customer email address or customer id.',
      );
    }

    const where: Prisma.CustomerWhereInput = UUID_PATTERN.test(query)
      ? { OR: [{ id: query }, { email: { equals: query, mode: 'insensitive' } }] }
      : { email: { equals: query, mode: 'insensitive' } };

    const customers = await this.prisma.customer.findMany({
      where,
      take: SEARCH_LIMIT,
      orderBy: { createdAt: 'asc' },
    });

    const balances = await this.balancesByCustomerId(
      customers.map((customer) => customer.id),
    );

    return {
      customers: customers.map((customer) =>
        this.toLoyaltyCustomer(customer, balances.get(customer.id) ?? 0),
      ),
    };
  }

  async getCustomerDetail(
    customerId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyCustomerDetail> {
    authorization.assertCorporate('loyalty.view');
    return this.buildCustomerDetail(customerId);
  }

  // The detail projection with NO authorization check — callers must have
  // already asserted `loyalty.view` (getCustomerDetail) or `loyalty.adjust`
  // (adjust, whose response must not additionally require `loyalty.view`).
  private async buildCustomerDetail(
    customerId: string,
  ): Promise<AdminLoyaltyCustomerDetail> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }

    const account = await this.prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true, balance: true },
    });

    const entries = account
      ? await this.prisma.mochaBeanLedgerEntry.findMany({
          where: { loyaltyAccountId: account.id },
          orderBy: { createdAt: 'desc' },
          take: LEDGER_PAGE_SIZE,
          include: {
            order: { select: { orderNumber: true } },
            actorInternalUser: {
              select: { displayName: true, email: true },
            },
          },
        })
      : [];

    return {
      customer: this.toLoyaltyCustomer(customer, account?.balance ?? 0),
      entries: entries.map((entry) => this.toLedgerEntry(entry)),
    };
  }

  // Manual HQ add/deduct. `reason` required (trimmed, non-empty). `deltaBeans`
  // a non-zero whole integer. `operationKey` a caller-supplied idempotency
  // key: a retry with the same key never applies the change twice. The
  // resulting balance may never go below zero. The ledger entry and the
  // InternalAuditEvent are written in the SAME transaction as the balance
  // move.
  async adjust(
    customerId: string,
    request: AdminAdjustMochaBeansRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyCustomerDetail> {
    authorization.assertCorporate('loyalty.adjust');

    const deltaBeans = this.validateDelta(request?.deltaBeans);
    const reason = this.validateReason(request?.reason);
    const operationKey = this.validateOperationKey(request?.operationKey);

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }

    // Lazily create the loyalty account outside the transaction (a P2002
    // race is caught and swallowed there, never abort a real write).
    await this.loyaltyService.ensureAccountForCustomer(customerId);

    // Fast-path idempotent replay for the common (sequential) retry: this
    // exact operationKey already applied. The authoritative re-check is
    // done again INSIDE the account lock below — this one only saves a
    // transaction when the key is plainly already there.
    const preexisting = await this.findAdjustmentByOperationKey(operationKey);
    if (preexisting) {
      this.assertOperationKeyOwnedBy(preexisting, customerId);
      return this.buildCustomerDetail(customerId);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const account = await tx.customerLoyaltyAccount.findUniqueOrThrow({
          where: { customerId },
          select: { id: true },
        });

        // Serialize every balance-changing write for this account (the same
        // row-lock pattern the operations checklists use).
        await tx.$queryRaw`SELECT id FROM "CustomerLoyaltyAccount" WHERE id = ${account.id} FOR UPDATE`;

        // Re-check idempotency INSIDE the lock: a concurrent request with
        // this operationKey may have committed between the fast-path check
        // above and our acquiring the lock. If so, this call is an
        // idempotent replay — return WITHOUT a second balance change,
        // ledger entry, or audit event, and without letting the below-zero
        // check reject it against the already-updated balance.
        const applied = await tx.mochaBeanLedgerEntry.findUnique({
          where: {
            type_operationKey: { type: 'MANUAL_ADJUSTMENT', operationKey },
          },
          select: { loyaltyAccountId: true },
        });
        if (applied) {
          if (applied.loyaltyAccountId !== account.id) {
            throw new ConflictException(
              'That operation key has already been used for a different customer.',
            );
          }
          return;
        }

        const locked = await tx.customerLoyaltyAccount.findUniqueOrThrow({
          where: { id: account.id },
          select: { balance: true },
        });

        const balanceBefore = locked.balance;
        const balanceAfter = balanceBefore + deltaBeans;
        if (balanceAfter < 0) {
          throw new ConflictException(
            `That deduction would take the balance below zero (current balance ${balanceBefore} Mocha Beans).`,
          );
        }

        await tx.mochaBeanLedgerEntry.create({
          data: {
            loyaltyAccountId: account.id,
            type: 'MANUAL_ADJUSTMENT',
            amount: deltaBeans,
            reason,
            operationKey,
            actorInternalUserId,
          },
        });

        await tx.customerLoyaltyAccount.update({
          where: { id: account.id },
          data: { balance: balanceAfter },
        });

        await this.audit.recordMochaBeansAdjusted(tx, {
          actorInternalUserId,
          customerId,
          deltaBeans,
          balanceBefore,
          balanceAfter,
          reason,
        });
      });
    } catch (error) {
      // A concurrent request with the same operationKey beat us to the
      // unique ledger row — treat it as the idempotent replay it is.
      if (isUniqueConstraintViolation(error)) {
        return this.buildCustomerDetail(customerId);
      }
      throw error;
    }

    return this.buildCustomerDetail(customerId);
  }

  private async findAdjustmentByOperationKey(
    operationKey: string,
  ): Promise<{ loyaltyAccount: { customerId: string } } | null> {
    return this.prisma.mochaBeanLedgerEntry.findUnique({
      where: {
        type_operationKey: { type: 'MANUAL_ADJUSTMENT', operationKey },
      },
      select: { loyaltyAccount: { select: { customerId: true } } },
    });
  }

  private assertOperationKeyOwnedBy(
    entry: { loyaltyAccount: { customerId: string } },
    customerId: string,
  ): void {
    if (entry.loyaltyAccount.customerId !== customerId) {
      throw new ConflictException(
        'That operation key has already been used for a different customer.',
      );
    }
  }

  private validateDelta(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw === 0) {
      throw new BadRequestException(
        'The adjustment must be a non-zero whole number of Mocha Beans.',
      );
    }
    return raw;
  }

  private validateReason(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A reason is required.');
    }
    const reason = raw.trim();
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `Reason is too long (maximum ${REASON_MAX_LENGTH} characters).`,
      );
    }
    return reason;
  }

  private validateOperationKey(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('An operationKey is required.');
    }
    const key = raw.trim();
    if (
      key.length < OPERATION_KEY_MIN_LENGTH ||
      key.length > OPERATION_KEY_MAX_LENGTH
    ) {
      throw new BadRequestException(
        `A valid operationKey (${OPERATION_KEY_MIN_LENGTH}-${OPERATION_KEY_MAX_LENGTH} characters) is required.`,
      );
    }
    return key;
  }

  private async balancesByCustomerId(
    customerIds: string[],
  ): Promise<Map<string, number>> {
    if (customerIds.length === 0) {
      return new Map();
    }
    const accounts = await this.prisma.customerLoyaltyAccount.findMany({
      where: { customerId: { in: customerIds } },
      select: { customerId: true, balance: true },
    });
    return new Map(accounts.map((a) => [a.customerId, a.balance]));
  }

  private toLoyaltyCustomer(
    customer: Prisma.CustomerGetPayload<Record<string, never>>,
    balance: number,
  ): AdminLoyaltyCustomer {
    return {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
      balance,
    };
  }

  private toLedgerEntry(entry: {
    id: string;
    type: 'EARN' | 'MANUAL_ADJUSTMENT';
    amount: number;
    reason: string | null;
    createdAt: Date;
    order: { orderNumber: string } | null;
    actorInternalUser: { displayName: string | null; email: string } | null;
  }): AdminMochaBeanLedgerEntry {
    return {
      id: entry.id,
      type: entry.type,
      amount: entry.amount,
      reason: entry.reason,
      orderNumber: entry.order?.orderNumber ?? null,
      actorLabel: entry.actorInternalUser
        ? entry.actorInternalUser.displayName ?? entry.actorInternalUser.email
        : null,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
