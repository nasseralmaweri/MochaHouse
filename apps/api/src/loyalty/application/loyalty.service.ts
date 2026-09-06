import { Injectable } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import { mochaBeansForQualifyingSpend } from '@mocha-house/domain';
import { PrismaService } from '../../prisma/prisma.service';

// The Mocha Beans core service (Milestone 7A): the authenticated-Order
// earning path and the customer balance read. Manual HQ add/deduct lives in
// LoyaltyAdminService — a separate, permission-guarded surface.
//
// Every balance-changing write (here and in the admin service) does two
// things inside ONE transaction: append a MochaBeanLedgerEntry AND move
// CustomerLoyaltyAccount.balance by the same signed delta. The ledger is
// the authoritative record; `balance` is a materialized projection kept for
// O(1) reads and as the single row a future redemption slice will lock.

export interface EarnForOrderInput {
  // The SAME transaction client that is creating the Order — so the Order
  // and its EARN entry commit or roll back together.
  tx: Prisma.TransactionClient;
  customerId: string;
  orderId: string;
  // Qualifying merchandise spend in integer minor units. For 7A this is
  // Order.subtotal (the platform has no tax/tip/fee/discount/gift-card
  // model yet).
  qualifyingSubtotalMinorUnits: number;
  currency: string;
}

@Injectable()
export class LoyaltyService {
  constructor(private readonly prisma: PrismaService) {}

  // Lazy per-customer loyalty-account creation. Called by CheckoutService
  // BEFORE the order-creation transaction (never inside it): a unique-key
  // race here can be caught and swallowed, whereas a P2002 inside the
  // checkout transaction would abort the whole order and trip
  // reconciliation. Idempotent — safe to call on every authenticated
  // checkout.
  async ensureAccountForCustomer(customerId: string): Promise<void> {
    try {
      await this.prisma.customerLoyaltyAccount.upsert({
        where: { customerId },
        create: { customerId },
        update: {},
      });
    } catch (error) {
      // A concurrent first checkout for the same customer won the race to
      // create the account. That is exactly the state we wanted — nothing
      // else to do.
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }
  }

  // Awards Mocha Beans for a successful authenticated Order. Called from
  // CheckoutService INSIDE the order-creation transaction, so:
  //   - a guest order (no customerId) never reaches here;
  //   - an order whose transaction rolls back (payment succeeded but order
  //     creation failed -> reconciliationRequired) earns nothing;
  //   - the Order row and the EARN ledger entry are atomic.
  //
  // USD only for 7A. `@@unique([type, orderId])` on the ledger is the
  // exactly-once-per-Order guarantee at the database level; this method is
  // only ever called once per order creation, so there is no second call to
  // race it.
  async earnForOrder(input: EarnForOrderInput): Promise<void> {
    const { tx, customerId, orderId, qualifyingSubtotalMinorUnits, currency } =
      input;

    // 7A earns on USD merchandise only — no currency conversion.
    if (currency !== 'USD') {
      return;
    }

    const beans = mochaBeansForQualifyingSpend(qualifyingSubtotalMinorUnits);
    if (beans <= 0) {
      // Sub-$1 qualifying spend earns nothing; don't write an empty entry.
      return;
    }

    // ensureAccountForCustomer ran before this transaction, so the row
    // exists. findUniqueOrThrow (not an in-transaction upsert) keeps every
    // INSERT out of the checkout transaction.
    const account = await tx.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId },
      select: { id: true },
    });

    await tx.mochaBeanLedgerEntry.create({
      data: {
        loyaltyAccountId: account.id,
        type: 'EARN',
        amount: beans,
        orderId,
      },
    });

    await tx.customerLoyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: beans } },
    });
  }

  // The current Mocha Bean balance for a customer. 0 (not an error) when
  // the customer has never earned or been adjusted — no account row yet.
  async getBalanceForCustomer(customerId: string): Promise<number> {
    const account = await this.prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { balance: true },
    });
    return account?.balance ?? 0;
  }
}

// Checked structurally (not `instanceof Prisma.PrismaClientKnownRequestError`)
// for the same reason CheckoutService does: a genuinely concurrent
// unique-constraint violation can surface through a different error identity
// than this module's own Prisma import resolves to.
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
