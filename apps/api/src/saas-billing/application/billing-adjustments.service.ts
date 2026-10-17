import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_ADJUSTMENT_ALREADY_DECIDED,
  BILLING_ADJUSTMENT_EXCEEDS_REMAINING,
  BILLING_ADJUSTMENT_EXPIRED,
  BILLING_ADJUSTMENT_IN_PROGRESS,
  BILLING_ADJUSTMENT_NOT_ELIGIBLE,
  BILLING_ADJUSTMENT_NOT_PENDING,
  BILLING_ADJUSTMENT_OWN_REQUEST,
  BILLING_UNAVAILABLE,
  type BillingAdjustmentKind,
  type BillingAdjustmentScope,
  type BillingAdjustmentStatus,
  type PlatformAdjustableInvoice,
  type PlatformAdjustmentListResponse,
  type PlatformAdjustmentPreview,
  type PlatformAdjustmentPreviewRequest,
  type PlatformAdjustmentView,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderAdjustableInvoice,
  type ProviderCreditNote,
  type ProviderCreditNoteInput,
  type ProviderRefund,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from '../provider/saas-billing-provider';
import { BillingLifecycleService } from './billing-lifecycle.service';

// SC3e-3 — CENTERIVO subscription refunds and credits (owner decisions
// D1–D6). A refund (to the original payment method) or a credit (toward
// future invoices) on one of a business's PAID CENTERIVO invoices, always as a
// Stripe credit note against that invoice. Stripe computes every amount and
// tax (previewed); nothing is calculated here.
//
//   request   (billing.adjustments.request, recent sign-in, a reason): the
//             invoice is checked live (ours, paid, the customer and
//             subscription as recorded) and Stripe's preview recorded — the
//             amounts, invoice, kind and requester never change afterwards;
//   approve   (billing.adjustments.approve, recent sign-in, a note): one
//             independent approver under $250 USD; two (distinct) at $250
//             or more, for any other currency, and for a full refund of an
//             annual period. Never the requester; one position per
//             operator; only ACTIVE operators still holding the permission
//             count; a request expires after 72 hours;
//   execute   by the final approval: RESERVED (EXECUTING) before Stripe is
//             called; the invoice, the remaining amount and Stripe's preview
//             re-checked immediately before; one credit note with the
//             adjustment's own idempotency key and id (metadata);
//   confirm   only from Stripe: the credit note issued for exactly the
//             previewed total, and for a refund the refund itself succeeded
//             (pending -> SUBMITTED; failed -> REVIEW). An interrupted call is
//             reconciled first (our credit note found by its id); re-sent
//             with the same key only within an hour; never after — reviewed.
//
// Refunds made directly in Stripe (credit notes, or refunds without one) are
// recorded as EXTERNAL adjustments and reviewed — never repeated, reversed or
// treated as approved here. Nothing here changes a subscription, its plan,
// status or modules, or any suspension. Never a restaurant order, payment or
// refund.

const REQUEST_TTL_MS = 72 * 60 * 60 * 1000;
// A reserved operation whose credit note is not found is re-sent (the same
// key; the provider keeps idempotency for 24 hours) only within this window.
const RESEND_WINDOW_MS = 60 * 60 * 1000;
// Two approvers at or above this amount (USD, minor units).
const SECOND_APPROVER_USD_MINOR = 25_000;
// A billed period this long or longer is annual.
const ANNUAL_PERIOD_MS = 300 * 24 * 60 * 60 * 1000;

export const EXTERNAL_ADJUSTMENT_CASE = 'EXTERNAL_BILLING_ADJUSTMENT';
export const ADJUSTMENT_UNCERTAIN_CASE = 'BILLING_ADJUSTMENT_UNCERTAIN';
export const ADJUSTMENT_REFUND_FAILED_CASE = 'BILLING_ADJUSTMENT_REFUND_FAILED';
export const ADJUSTMENT_MISMATCH_CASE = 'BILLING_ADJUSTMENT_MISMATCH';

type Tx = Prisma.TransactionClient;
const OPEN: BillingAdjustmentStatus[] = [
  'PENDING_APPROVAL',
  'EXECUTING',
  'SUBMITTED',
  'REVIEW',
];

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: 'The payment provider is not available. Nothing was changed.',
  });
}

const notEligible = (message: string) =>
  conflict(BILLING_ADJUSTMENT_NOT_ELIGIBLE, message);

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function text(value: unknown, what: string): string {
  const out = typeof value === 'string' ? value.trim() : '';
  if (out.length < 10 || out.length > 500 || hasControlCharacter(out)) {
    throw new BadRequestException(
      `${what} of 10 to 500 characters (one line) is required.`,
    );
  }
  return out;
}

export function parseAdjustmentInput(
  body: unknown,
  withReason: boolean,
): PlatformAdjustmentPreviewRequest & { reason?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException(
      'Send { kind, scope, lineId?, amountMinorUnits? }.',
    );
  }
  const allowed = new Set([
    'kind',
    'scope',
    'lineId',
    'amountMinorUnits',
    ...(withReason ? ['reason'] : []),
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new BadRequestException('Unexpected field.');
  }
  const input = body as Record<string, unknown>;
  if (input.kind !== 'REFUND' && input.kind !== 'CREDIT') {
    throw new BadRequestException('kind must be REFUND or CREDIT.');
  }
  if (input.scope !== 'FULL' && input.scope !== 'PARTIAL') {
    throw new BadRequestException('scope must be FULL or PARTIAL.');
  }
  if (input.scope === 'FULL') {
    if (input.lineId !== undefined || input.amountMinorUnits !== undefined) {
      throw new BadRequestException(
        'A full adjustment names no line or amount.',
      );
    }
  } else if (
    typeof input.lineId !== 'string' ||
    !/^[A-Za-z0-9_]{1,255}$/.test(input.lineId) ||
    typeof input.amountMinorUnits !== 'number' ||
    !Number.isInteger(input.amountMinorUnits) ||
    input.amountMinorUnits < 1
  ) {
    throw new BadRequestException(
      'A partial adjustment names one invoice line and a whole, positive pre-tax amount.',
    );
  }
  return {
    kind: input.kind,
    scope: input.scope,
    ...(input.scope === 'PARTIAL'
      ? {
          lineId: input.lineId,
          amountMinorUnits: input.amountMinorUnits,
        }
      : {}),
    ...(withReason ? { reason: text(input.reason, 'A reason') } : {}),
  };
}

export function parseNote(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'note'
  ) {
    throw new BadRequestException('Send exactly { note }.');
  }
  return text((body as { note: unknown }).note, 'A note');
}

// How many independent approvers the policy requires (owner decision D2).
export function requiredApprovals(
  currency: string,
  totalMinorUnits: number,
  annualFullRefund: boolean,
): 1 | 2 {
  if (annualFullRefund) return 2;
  if (currency !== 'usd') return 2;
  return totalMinorUnits >= SECOND_APPROVER_USD_MINOR ? 2 : 1;
}

export const adjustmentIdempotencyKey = (id: string) =>
  `centerivo-adjustment-${id}`;

interface LiveInvoice {
  live: ProviderAdjustableInvoice;
  notes: ProviderCreditNote[];
  refunds: ProviderRefund[];
  adjustedMinorUnits: number;
  remainingMinorUnits: number;
  refundableMinorUnits: number;
  annual: boolean;
}

const ADJUSTMENT_INCLUDE = {
  invoice: true,
  subscription: { include: { subscriberTenant: true } },
  requestedBy: { select: { id: true, email: true } },
  decisions: {
    orderBy: { createdAt: 'asc' },
    include: { operator: { select: { id: true, email: true } } },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { email: true } } },
  },
} as const satisfies Prisma.BillingAdjustmentInclude;
type AdjustmentRow = Prisma.BillingAdjustmentGetPayload<{
  include: typeof ADJUSTMENT_INCLUDE;
}>;

@Injectable()
export class BillingAdjustmentsService {
  private readonly logger = new Logger(BillingAdjustmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BillingLifecycleService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  // --- the invoice, live -----------------------------------------------------------

  // THIS business's invoice (our records), billed by the configured provider.
  private async ownInvoice(tenantId: string, invoiceId: string) {
    if (!isUuid(tenantId) || !isUuid(invoiceId)) {
      throw new NotFoundException('Invoice not found.');
    }
    const row = await this.prisma.billingInvoice.findFirst({
      where: { id: invoiceId, subscription: { subscriberTenantId: tenantId } },
    });
    if (!row) throw new NotFoundException('Invoice not found.');
    if (!this.provider.available || row.provider !== this.provider.name) {
      throw unavailable();
    }
    return row;
  }

  // What Stripe holds now: ours (the customer, subscription and currency as
  // recorded), paid, and how much is left to refund or credit.
  private async liveInvoice(row: {
    externalInvoiceId: string;
    externalCustomerId: string;
    externalSubscriptionId: string;
    currency: string;
  }): Promise<LiveInvoice> {
    const live = await this.provider.retrieveAdjustableInvoice(
      row.externalInvoiceId,
    );
    if (
      live === null ||
      live.livemode !== this.provider.livemode ||
      live.externalInvoiceId !== row.externalInvoiceId ||
      live.externalCustomerId !== row.externalCustomerId ||
      live.externalSubscriptionId !== row.externalSubscriptionId ||
      live.currency !== row.currency
    ) {
      throw notEligible(
        "The payment provider's invoice doesn't match our records.",
      );
    }
    if (live.status !== 'paid' || live.amountPaidMinorUnits <= 0) {
      throw notEligible('Only a paid invoice can be refunded or credited.');
    }
    const notes = await this.provider.listCreditNotes(row.externalInvoiceId);
    const refunds = await this.provider.listInvoiceRefunds(
      row.externalInvoiceId,
    );
    const inNotes = new Set(
      notes.flatMap((note) =>
        note.refunds.map((refund) => refund.externalRefundId),
      ),
    );
    // Refunds made on the payment without a credit note.
    const outsideNotes = refunds
      .filter(
        (refund) =>
          !inNotes.has(refund.externalRefundId) &&
          refund.status !== 'failed' &&
          refund.status !== 'canceled',
      )
      .reduce((total, refund) => total + refund.amountMinorUnits, 0);
    const issued = notes
      .filter((note) => note.status === 'issued')
      .reduce((total, note) => total + note.totalMinorUnits, 0);
    const adjusted =
      Math.max(live.postPaymentCreditMinorUnits, issued) + outsideNotes;
    return {
      live,
      notes,
      refunds,
      adjustedMinorUnits: adjusted,
      remainingMinorUnits: Math.max(0, live.amountPaidMinorUnits - adjusted),
      refundableMinorUnits: Math.max(
        0,
        live.chargeCapturedMinorUnits - live.chargeRefundedMinorUnits,
      ),
      annual: live.lines.some(
        (line) =>
          line.periodStart !== null &&
          line.periodEnd !== null &&
          line.periodEnd.getTime() - line.periodStart.getTime() >=
            ANNUAL_PERIOD_MS,
      ),
    };
  }

  async adjustableInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<PlatformAdjustableInvoice> {
    const row = await this.ownInvoice(tenantId, invoiceId);
    const live = await this.read(() => this.liveInvoice(row));
    return {
      invoiceId: row.id,
      number: row.number,
      currency: row.currency.toUpperCase(),
      amountPaidMinorUnits: live.live.amountPaidMinorUnits,
      adjustedMinorUnits: live.adjustedMinorUnits,
      remainingMinorUnits: live.remainingMinorUnits,
      refundable:
        live.live.paymentIntentIds.length > 0 && live.refundableMinorUnits > 0,
      annual: live.annual,
      lines: live.live.lines
        .filter((line) => line.amountMinorUnits > 0)
        .map((line) => ({
          lineId: line.externalLineId,
          description: line.description,
          amountMinorUnits: line.amountMinorUnits,
        })),
    };
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
  }

  // The credit-note lines for a request (the pre-tax amounts; Stripe adds
  // tax): every line in full, or one line and an amount.
  private lines(
    live: ProviderAdjustableInvoice,
    input: PlatformAdjustmentPreviewRequest,
  ): ProviderCreditNoteInput['lines'] {
    if (input.scope === 'FULL') {
      const lines = live.lines
        .filter((line) => line.amountMinorUnits > 0)
        .map((line) => ({
          externalLineId: line.externalLineId,
          amountMinorUnits: line.amountMinorUnits,
        }));
      if (lines.length === 0)
        throw notEligible('The invoice has nothing to credit.');
      return lines;
    }
    const line = live.lines.find(
      (candidate) => candidate.externalLineId === input.lineId,
    );
    if (!line || input.amountMinorUnits! > line.amountMinorUnits) {
      throw notEligible(
        'Choose a line of this invoice and at most its amount.',
      );
    }
    return [
      {
        externalLineId: line.externalLineId,
        amountMinorUnits: input.amountMinorUnits!,
      },
    ];
  }

  // Stripe's preview, within what remains (and, for a refund, what the
  // payment can still return).
  private async previewChecked(
    row: { externalInvoiceId: string; currency: string },
    live: LiveInvoice,
    input: PlatformAdjustmentPreviewRequest,
  ) {
    if (
      input.kind === 'REFUND' &&
      (live.live.paymentIntentIds.length === 0 ||
        live.refundableMinorUnits <= 0)
    ) {
      throw notEligible(
        "This invoice wasn't paid by a charge that can be refunded; a credit toward future invoices is possible instead.",
      );
    }
    if (input.scope === 'FULL' && live.adjustedMinorUnits > 0) {
      throw notEligible(
        'This invoice was already partly refunded or credited; a full adjustment is not possible (request a partial one).',
      );
    }
    const lines = this.lines(live.live, input);
    // Before tax already more than remains: refused without asking the
    // provider (its preview would refuse it too).
    if (
      lines.reduce((total, line) => total + line.amountMinorUnits, 0) >
      live.remainingMinorUnits
    ) {
      throw conflict(
        BILLING_ADJUSTMENT_EXCEEDS_REMAINING,
        'That is more than remains to refund or credit on this invoice.',
      );
    }
    const preview = await this.provider.previewCreditNote({
      externalInvoiceId: row.externalInvoiceId,
      kind: input.kind,
      lines,
    });
    if (preview.currency !== row.currency || preview.totalMinorUnits <= 0) {
      throw notEligible(
        "The payment provider's preview doesn't match the invoice.",
      );
    }
    if (preview.totalMinorUnits > live.remainingMinorUnits) {
      throw conflict(
        BILLING_ADJUSTMENT_EXCEEDS_REMAINING,
        'That is more than remains to refund or credit on this invoice.',
      );
    }
    if (
      input.kind === 'REFUND' &&
      preview.totalMinorUnits > live.refundableMinorUnits
    ) {
      throw conflict(
        BILLING_ADJUSTMENT_EXCEEDS_REMAINING,
        'That is more than the payment can still return.',
      );
    }
    const annualFullRefund =
      input.kind === 'REFUND' && input.scope === 'FULL' && live.annual;
    // The policy threshold counts everything already refunded or credited on
    // this invoice too: splitting a refund never avoids the second approver.
    const approvals = requiredApprovals(
      preview.currency,
      live.adjustedMinorUnits + preview.totalMinorUnits,
      annualFullRefund,
    );
    return { lines, preview, annualFullRefund, approvals };
  }

  async preview(
    tenantId: string,
    invoiceId: string,
    input: PlatformAdjustmentPreviewRequest,
  ): Promise<PlatformAdjustmentPreview> {
    const row = await this.ownInvoice(tenantId, invoiceId);
    return this.read(async () => {
      const live = await this.liveInvoice(row);
      const { preview, annualFullRefund, approvals } =
        await this.previewChecked(row, live, input);
      return {
        kind: input.kind,
        scope: input.scope,
        currency: preview.currency.toUpperCase(),
        totalMinorUnits: preview.totalMinorUnits,
        taxMinorUnits: preview.taxMinorUnits,
        remainingAfterMinorUnits:
          live.remainingMinorUnits - preview.totalMinorUnits,
        requiredApprovals: approvals,
        annualFullRefund,
      };
    });
  }

  // --- request ---------------------------------------------------------------------

  async request(
    tenantId: string,
    invoiceId: string,
    input: PlatformAdjustmentPreviewRequest & { reason: string },
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformAdjustmentView> {
    const row = await this.ownInvoice(tenantId, invoiceId);
    const open = await this.prisma.billingAdjustment.count({
      where: { invoiceId: row.id, origin: 'CENTERIVO', status: { in: OPEN } },
    });
    if (open > 0) {
      throw conflict(
        BILLING_ADJUSTMENT_IN_PROGRESS,
        'A refund or credit is already open for this invoice.',
      );
    }
    const { lines, preview, annualFullRefund, approvals } = await this.read(
      async () => {
        const live = await this.liveInvoice(row);
        return this.previewChecked(row, live, input);
      },
    );
    let id: string;
    try {
      id = await runSerializable(this.prisma, async (tx) => {
        const created = await tx.billingAdjustment.create({
          data: {
            subscriptionId: row.subscriptionId,
            invoiceId: row.id,
            origin: 'CENTERIVO',
            kind: input.kind,
            scope: input.scope,
            status: 'PENDING_APPROVAL',
            currency: preview.currency,
            totalMinorUnits: preview.totalMinorUnits,
            taxMinorUnits: preview.taxMinorUnits,
            annualFullRefund,
            requiredApprovals: approvals,
            reason: input.reason,
            requestedByOperatorId: operator.id,
            lineSpec: lines,
            expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
          },
          select: { id: true },
        });
        await this.event(tx, created.id, 'REQUESTED', null, operator.id);
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.billingAdjustmentRequested,
          input.kind,
          tenantId,
          operator.id,
          requestReference,
        );
        return created.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          BILLING_ADJUSTMENT_IN_PROGRESS,
          'A refund or credit is already open for this invoice.',
        );
      }
      throw error;
    }
    return this.detail(id);
  }

  // --- decisions -------------------------------------------------------------------

  async decide(
    adjustmentId: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformAdjustmentView> {
    const adjustment = await this.load(adjustmentId);
    if (
      adjustment.origin !== 'CENTERIVO' ||
      adjustment.status !== 'PENDING_APPROVAL'
    ) {
      throw conflict(
        BILLING_ADJUSTMENT_NOT_PENDING,
        'This request is not awaiting approval.',
      );
    }
    if (adjustment.expiresAt!.getTime() <= now.getTime()) {
      await this.expire(adjustment.id, now);
      throw conflict(
        BILLING_ADJUSTMENT_EXPIRED,
        'This request expired (72 hours). Request it again.',
      );
    }
    if (adjustment.requestedByOperatorId === operator.id) {
      throw conflict(
        BILLING_ADJUSTMENT_OWN_REQUEST,
        "You can't decide on your own request.",
      );
    }
    if (
      adjustment.decisions.some(
        (existing) => existing.operatorId === operator.id,
      )
    ) {
      throw conflict(
        BILLING_ADJUSTMENT_ALREADY_DECIDED,
        'You already decided on this request; another operator must.',
      );
    }
    const execute = await runSerializable(this.prisma, async (tx) => {
      const fresh = await tx.billingAdjustment.findUniqueOrThrow({
        where: { id: adjustment.id },
        select: { status: true },
      });
      if (fresh.status !== 'PENDING_APPROVAL') {
        throw conflict(
          BILLING_ADJUSTMENT_NOT_PENDING,
          'This request is not awaiting approval.',
        );
      }
      await tx.billingAdjustmentDecision.create({
        data: {
          adjustmentId: adjustment.id,
          operatorId: operator.id,
          decision,
          note,
        },
      });
      await this.event(tx, adjustment.id, decision, null, operator.id);
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.billingAdjustmentDecided,
        decision,
        adjustment.subscription.subscriberTenantId,
        operator.id,
        requestReference,
      );
      if (decision === 'REJECTED') {
        await tx.billingAdjustment.update({
          where: { id: adjustment.id },
          data: { status: 'REJECTED', finishedAt: now },
        });
        return false;
      }
      // The final approval RESERVES it (EXECUTING) in the same
      // transaction, so a concurrent approval finds it no longer pending.
      if (
        (await this.validApprovals(
          tx,
          adjustment.id,
          adjustment.requestedByOperatorId!,
        )) < adjustment.requiredApprovals
      ) {
        return false;
      }
      await tx.billingAdjustment.update({
        where: { id: adjustment.id },
        data: { status: 'EXECUTING', executionStartedAt: now },
      });
      await this.event(tx, adjustment.id, 'EXECUTING', null, operator.id);
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.billingAdjustmentExecuted,
        adjustment.kind,
        adjustment.subscription.subscriberTenantId,
        operator.id,
        requestReference,
      );
      return true;
    });
    if (execute) await this.submit(adjustment.id);
    return this.detail(adjustment.id);
  }

  // The requester withdraws its own request before it is executed.
  async cancel(
    adjustmentId: string,
    note: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformAdjustmentView> {
    const adjustment = await this.load(adjustmentId);
    if (adjustment.requestedByOperatorId !== operator.id) {
      throw conflict(
        BILLING_ADJUSTMENT_NOT_PENDING,
        'Only the requester can withdraw a request.',
      );
    }
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingAdjustment.updateMany({
        where: { id: adjustment.id, status: 'PENDING_APPROVAL' },
        data: { status: 'CANCELED', finishedAt: new Date() },
      });
      if (count !== 1) {
        throw conflict(
          BILLING_ADJUSTMENT_NOT_PENDING,
          'This request is not awaiting approval.',
        );
      }
      await this.event(tx, adjustment.id, 'CANCELED', null, operator.id, note);
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.billingAdjustmentCanceled,
        'CANCELED',
        adjustment.subscription.subscriberTenantId,
        operator.id,
        requestReference,
      );
    });
    return this.detail(adjustment.id);
  }

  // Approvals that still count: by ACTIVE operators who still hold
  // billing.adjustments.approve, never the requester.
  private async validApprovals(
    tx: Tx,
    adjustmentId: string,
    requesterId: string,
  ) {
    return tx.billingAdjustmentDecision.count({
      where: {
        adjustmentId,
        decision: 'APPROVED',
        operatorId: { not: requesterId },
        operator: {
          status: 'ACTIVE',
          permissions: {
            some: {
              permission: 'billing.adjustments.approve',
              revokedAt: null,
            },
          },
        },
      },
    });
  }

  private async expire(id: string, now: Date): Promise<void> {
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingAdjustment.updateMany({
        where: { id, status: 'PENDING_APPROVAL', expiresAt: { lte: now } },
        data: { status: 'EXPIRED', finishedAt: now },
      });
      if (count === 1) await this.event(tx, id, 'EXPIRED', null, null);
    });
  }

  // --- execution -----------------------------------------------------------------

  // Immediately before the provider call: the invoice is still ours and
  // paid, what remains still covers it, and Stripe's preview is exactly what
  // was approved. Otherwise nothing is sent (FAILED). A provider error leaves
  // it EXECUTING (uncertain) for reconciliation.
  private async submit(adjustmentId: string): Promise<void> {
    const adjustment = await this.prisma.billingAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
      include: { invoice: true },
    });
    if (adjustment.status !== 'EXECUTING') return;
    const input = {
      kind: adjustment.kind as 'REFUND' | 'CREDIT',
      lines: adjustment.lineSpec as unknown as ProviderCreditNoteInput['lines'],
    };
    let failure: string | null = null;
    try {
      const live = await this.liveInvoice(adjustment.invoice);
      if (
        live.notes.some((note) => note.centerivoAdjustmentId === adjustment.id)
      ) {
        // Already issued (an earlier attempt): confirm it.
        await this.settle(adjustment.id);
        return;
      }
      const preview = await this.provider.previewCreditNote({
        externalInvoiceId: adjustment.invoice.externalInvoiceId,
        ...input,
      });
      if (
        preview.currency !== adjustment.currency ||
        preview.totalMinorUnits !== adjustment.totalMinorUnits ||
        preview.taxMinorUnits !== adjustment.taxMinorUnits
      ) {
        failure = 'PREVIEW_CHANGED';
      } else if (adjustment.totalMinorUnits > live.remainingMinorUnits) {
        failure = 'EXCEEDS_REMAINING';
      } else if (
        input.kind === 'REFUND' &&
        adjustment.totalMinorUnits > live.refundableMinorUnits
      ) {
        failure = 'NOT_REFUNDABLE';
      }
    } catch (error) {
      if (error instanceof ConflictException) {
        failure = 'INVOICE_CHANGED';
      } else if (error instanceof SaasBillingProviderError) {
        // Nothing was sent: retried by the sweep within its window.
        await this.prisma.billingAdjustmentEvent.create({
          data: {
            adjustmentId,
            type: 'SUBMIT_DEFERRED',
            code: 'PROVIDER_UNAVAILABLE',
          },
        });
        return;
      } else {
        throw error;
      }
    }
    if (failure !== null) {
      await this.finishFailed(adjustment.id, failure);
      return;
    }
    try {
      await this.provider.createCreditNote({
        idempotencyKey: adjustmentIdempotencyKey(adjustment.id),
        adjustmentId: adjustment.id,
        note: {
          externalInvoiceId: adjustment.invoice.externalInvoiceId,
          ...input,
        },
        totalMinorUnits: adjustment.totalMinorUnits,
      });
    } catch (error) {
      if (!(error instanceof SaasBillingProviderError)) throw error;
      // The provider may or may not have issued it: never treated as done
      // or failed until Stripe is read (settle / sweep).
      await this.prisma.billingAdjustmentEvent.create({
        data: {
          adjustmentId,
          type: 'SUBMIT_UNCERTAIN',
          code: codeOf(error.code),
        },
      });
      return;
    }
    await this.prisma.billingAdjustmentEvent.create({
      data: { adjustmentId, type: 'CREDIT_NOTE_REQUESTED' },
    });
    await this.settle(adjustment.id);
  }

  private async finishFailed(
    adjustmentId: string,
    code: string,
  ): Promise<void> {
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingAdjustment.updateMany({
        where: { id: adjustmentId, status: { in: ['EXECUTING', 'REVIEW'] } },
        data: { status: 'FAILED', failureCode: code, finishedAt: new Date() },
      });
      if (count === 1) await this.event(tx, adjustmentId, 'FAILED', code, null);
    });
  }

  // --- confirmation from Stripe ----------------------------------------------------

  // Our credit note (found by its adjustment id) and, for a refund, the
  // refund itself. Returns NOT_FOUND when Stripe holds no credit note of ours.
  async settle(
    adjustmentId: string,
  ): Promise<'SUCCEEDED' | 'SUBMITTED' | 'REVIEW' | 'NOT_FOUND' | 'NONE'> {
    const adjustment = await this.prisma.billingAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
      include: { invoice: true },
    });
    if (
      adjustment.origin !== 'CENTERIVO' ||
      !['EXECUTING', 'SUBMITTED', 'REVIEW'].includes(adjustment.status)
    ) {
      return 'NONE';
    }
    let notes: ProviderCreditNote[];
    let refunds: ProviderRefund[];
    try {
      notes = (
        await this.provider.listCreditNotes(
          adjustment.invoice.externalInvoiceId,
        )
      ).filter((note) => note.centerivoAdjustmentId === adjustment.id);
      refunds = await this.provider.listInvoiceRefunds(
        adjustment.invoice.externalInvoiceId,
      );
    } catch (error) {
      if (error instanceof SaasBillingProviderError) return 'NONE';
      throw error;
    }
    if (notes.length === 0) return 'NOT_FOUND';
    const note = notes[0];
    let outcome: 'SUCCEEDED' | 'SUBMITTED' | 'REVIEW';
    let code: string | null = null;
    let caseKind: string | null = null;
    if (
      notes.length > 1 ||
      note.livemode !== this.provider.livemode ||
      note.status !== 'issued' ||
      note.currency !== adjustment.currency ||
      note.totalMinorUnits !== adjustment.totalMinorUnits ||
      note.taxMinorUnits !== adjustment.taxMinorUnits ||
      note.outOfBandMinorUnits !== 0
    ) {
      outcome = 'REVIEW';
      code =
        notes.length > 1 ? 'DUPLICATE_CREDIT_NOTES' : 'CREDIT_NOTE_MISMATCH';
      caseKind = ADJUSTMENT_MISMATCH_CASE;
    } else if (adjustment.kind === 'CREDIT') {
      outcome = note.refunds.length === 0 ? 'SUCCEEDED' : 'REVIEW';
      if (outcome === 'REVIEW') {
        code = 'CREDIT_REFUNDED';
        caseKind = ADJUSTMENT_MISMATCH_CASE;
      }
    } else {
      const refunded = note.refunds.reduce(
        (total, refund) => total + refund.amountMinorUnits,
        0,
      );
      const statuses = note.refunds.map(
        (link) =>
          refunds.find(
            (refund) => refund.externalRefundId === link.externalRefundId,
          )?.status ?? 'unknown',
      );
      if (
        refunded !== adjustment.totalMinorUnits ||
        note.refunds.length === 0
      ) {
        outcome = 'REVIEW';
        code = 'REFUND_AMOUNT_MISMATCH';
        caseKind = ADJUSTMENT_MISMATCH_CASE;
      } else if (statuses.every((status) => status === 'succeeded')) {
        outcome = 'SUCCEEDED';
      } else if (
        statuses.some((status) => status === 'failed' || status === 'canceled')
      ) {
        outcome = 'REVIEW';
        code = 'REFUND_FAILED';
        caseKind = ADJUSTMENT_REFUND_FAILED_CASE;
      } else {
        outcome = 'SUBMITTED';
        code = 'REFUND_PENDING';
      }
    }
    const applied = await runSerializable(this.prisma, async (tx) => {
      const fresh = await tx.billingAdjustment.findUniqueOrThrow({
        where: { id: adjustment.id },
        include: { subscription: { select: { subscriberTenantId: true } } },
      });
      if (fresh.status === outcome) return false;
      if (!['EXECUTING', 'SUBMITTED', 'REVIEW'].includes(fresh.status))
        return false;
      // SUBMITTED -> REVIEW is allowed; REVIEW -> SUBMITTED only when the
      // refund is still pending after a recheck.
      await tx.billingAdjustment.update({
        where: { id: adjustment.id },
        data: {
          status: outcome,
          externalCreditNoteId:
            fresh.externalCreditNoteId ?? note.externalCreditNoteId,
          externalRefundId:
            fresh.externalRefundId ?? note.refunds[0]?.externalRefundId ?? null,
          submittedAt: fresh.submittedAt ?? new Date(),
          ...(outcome === 'SUCCEEDED' ? { finishedAt: new Date() } : {}),
          ...(code !== null && outcome !== 'SUBMITTED'
            ? { failureCode: code }
            : {}),
        },
      });
      await this.event(tx, adjustment.id, outcome, code, null);
      if (caseKind !== null) {
        await this.lifecycle.openCase(
          tx,
          caseKind,
          adjustment.subscriptionId,
          null,
          `Adjustment ${adjustment.id} (${adjustment.kind} ${adjustment.totalMinorUnits} ${adjustment.currency}) on invoice ${adjustment.invoice.externalInvoiceId}: ${code} (credit note ${note.externalCreditNoteId}). Nothing was repeated or reversed.`,
        );
      }
      if (outcome === 'SUCCEEDED') {
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.billingAdjustmentSettled,
          adjustment.kind,
          fresh.subscription.subscriberTenantId,
          null,
          undefined,
        );
      }
      return true;
    });
    if (applied)
      await this.refreshInvoiceHistory(adjustment.invoice.externalInvoiceId);
    return outcome;
  }

  // The billing history follows the credit note (best effort: the invoice
  // events and the reconciliation sweep do it too).
  private async refreshInvoiceHistory(
    externalInvoiceId: string,
  ): Promise<void> {
    try {
      const invoice = await this.provider.retrieveInvoice(externalInvoiceId);
      if (!invoice?.record) return;
      const row = await this.prisma.billingInvoice.findFirst({
        where: { provider: this.provider.name, externalInvoiceId },
        include: { subscription: true },
      });
      if (!row) return;
      const readAt = new Date();
      await runSerializable(this.prisma, (tx) =>
        this.lifecycle.recordInvoiceHistory(
          tx,
          row.subscription,
          invoice.record!,
          readAt,
          null,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Invoice history refresh failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  // --- the sweep -------------------------------------------------------------------

  // Expires requests past 72 hours; confirms executing and submitted ones
  // from Stripe; an operation whose credit note is not found is re-sent
  // (the same key, approvals re-checked) only within an hour of being
  // reserved, otherwise reviewed — never blindly retried.
  async sweep(
    now: Date = new Date(),
  ): Promise<{ expired: number; settled: number; reviewed: number }> {
    const result = { expired: 0, settled: 0, reviewed: 0 };
    const stale = await this.prisma.billingAdjustment.findMany({
      where: { status: 'PENDING_APPROVAL', expiresAt: { lte: now } },
      select: { id: true },
      take: 200,
    });
    for (const row of stale) {
      await this.expire(row.id, now);
      result.expired++;
    }
    if (!this.provider.available) return result;
    const open = await this.prisma.billingAdjustment.findMany({
      where: {
        origin: 'CENTERIVO',
        status: { in: ['EXECUTING', 'SUBMITTED', 'REVIEW'] },
      },
      orderBy: { executionStartedAt: 'asc' },
      take: 100,
    });
    for (const adjustment of open) {
      try {
        const outcome = await this.settle(adjustment.id);
        if (outcome === 'SUCCEEDED' || outcome === 'SUBMITTED')
          result.settled++;
        if (outcome !== 'NOT_FOUND' || adjustment.status !== 'EXECUTING')
          continue;
        const age = now.getTime() - adjustment.executionStartedAt!.getTime();
        const stillApproved =
          (await this.validApprovals(
            this.prisma,
            adjustment.id,
            adjustment.requestedByOperatorId!,
          )) >= adjustment.requiredApprovals;
        if (age < RESEND_WINDOW_MS && stillApproved) {
          await this.submit(adjustment.id);
          continue;
        }
        await runSerializable(this.prisma, async (tx) => {
          const { count } = await tx.billingAdjustment.updateMany({
            where: { id: adjustment.id, status: 'EXECUTING' },
            data: {
              status: 'REVIEW',
              failureCode: stillApproved ? 'UNCERTAIN' : 'APPROVAL_REVOKED',
            },
          });
          if (count !== 1) return;
          await this.event(
            tx,
            adjustment.id,
            'REVIEW',
            stillApproved ? 'UNCERTAIN' : 'APPROVAL_REVOKED',
            null,
          );
          await this.lifecycle.openCase(
            tx,
            ADJUSTMENT_UNCERTAIN_CASE,
            adjustment.subscriptionId,
            null,
            `Adjustment ${adjustment.id}: reserved ${new Date(adjustment.executionStartedAt!).toISOString()}, no credit note of ours found at the payment provider and not re-sent (${stillApproved ? 'past the re-send window' : 'an approval no longer counts'}). Check the provider; resolve it as not issued once confirmed.`,
          );
        });
        result.reviewed++;
      } catch (error) {
        this.logger.error(
          `Adjustment ${adjustment.id} sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return result;
  }

  // An operator closes a reviewed adjustment as NOT issued — only once
  // Stripe is read and holds no credit note of ours (otherwise it is
  // confirmed instead). billing.adjustments.approve, recent sign-in.
  async resolveNotIssued(
    adjustmentId: string,
    note: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformAdjustmentView> {
    const adjustment = await this.load(adjustmentId);
    if (adjustment.requestedByOperatorId === operator.id) {
      throw conflict(
        BILLING_ADJUSTMENT_OWN_REQUEST,
        'You requested this, so another operator must resolve it.',
      );
    }
    if (adjustment.status !== 'REVIEW') {
      throw conflict(
        BILLING_ADJUSTMENT_NOT_PENDING,
        'Only an adjustment under review can be resolved.',
      );
    }
    const outcome = await this.read(() => this.settle(adjustment.id));
    if (outcome === 'NOT_FOUND') {
      await runSerializable(this.prisma, async (tx) => {
        const { count } = await tx.billingAdjustment.updateMany({
          where: {
            id: adjustment.id,
            status: 'REVIEW',
            externalCreditNoteId: null,
          },
          data: {
            status: 'FAILED',
            failureCode: 'NOT_ISSUED',
            finishedAt: new Date(),
          },
        });
        if (count !== 1) return;
        await this.event(
          tx,
          adjustment.id,
          'FAILED',
          'NOT_ISSUED',
          operator.id,
          note,
        );
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.billingAdjustmentDecided,
          'NOT_ISSUED',
          adjustment.subscription.subscriberTenantId,
          operator.id,
          requestReference,
        );
      });
    }
    return this.detail(adjustment.id);
  }

  // --- external adjustments --------------------------------------------------------

  // A verified provider event about an invoice or a refund: the invoice's
  // refunds and credits are reconciled (ours confirmed; anything else
  // recorded as external and reviewed).
  async reconcileForEvent(
    verified: VerifiedBillingProviderEvent,
  ): Promise<void> {
    const event = verified.event;
    let externalInvoiceId: string | null = null;
    if (event.kind === 'INVOICE_CHANGED') externalInvoiceId = event.reference;
    if (event.kind === 'REFUND_CHANGED') {
      externalInvoiceId = await this.provider.findInvoiceForPayment(
        event.paymentIntentId,
      );
    }
    if (externalInvoiceId === null) return;
    const row = await this.prisma.billingInvoice.findFirst({
      where: { provider: verified.provider, externalInvoiceId },
      select: { id: true },
    });
    if (row) await this.reconcileInvoice(row.id);
  }

  async reconcileInvoice(invoiceId: string): Promise<{ recorded: number }> {
    const row = await this.prisma.billingInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { subscription: { select: { subscriberTenantId: true } } },
    });
    if (row.provider !== this.provider.name || !this.provider.available) {
      return { recorded: 0 };
    }
    const notes = await this.provider.listCreditNotes(row.externalInvoiceId);
    const refunds = await this.provider.listInvoiceRefunds(
      row.externalInvoiceId,
    );
    const ours = await this.prisma.billingAdjustment.findMany({
      where: { invoiceId: row.id, origin: 'CENTERIVO' },
      select: { id: true },
    });
    const ourIds = new Set(ours.map((adjustment) => adjustment.id));
    let recorded = 0;
    for (const note of notes) {
      if (note.livemode !== this.provider.livemode || note.status !== 'issued')
        continue;
      if (
        note.centerivoAdjustmentId !== null &&
        ourIds.has(note.centerivoAdjustmentId)
      ) {
        if ((await this.settle(note.centerivoAdjustmentId)) === 'NONE') {
          await this.reviewLateNote(
            note.centerivoAdjustmentId,
            note.externalCreditNoteId,
          );
        }
        continue;
      }
      const kind: BillingAdjustmentKind =
        note.refunds.length > 0
          ? 'REFUND'
          : note.outOfBandMinorUnits > 0
            ? 'OUT_OF_BAND'
            : 'CREDIT';
      if (
        await this.recordExternal(row, {
          kind,
          currency: note.currency,
          totalMinorUnits: note.totalMinorUnits,
          taxMinorUnits: note.taxMinorUnits,
          externalCreditNoteId: note.externalCreditNoteId,
          externalRefundId: null,
          detail: `credit note ${note.externalCreditNoteId}`,
        })
      ) {
        recorded++;
      }
    }
    const inNotes = new Set(
      notes.flatMap((note) =>
        note.refunds.map((refund) => refund.externalRefundId),
      ),
    );
    for (const refund of refunds) {
      if (
        inNotes.has(refund.externalRefundId) ||
        refund.livemode !== this.provider.livemode ||
        refund.status === 'failed' ||
        refund.status === 'canceled'
      ) {
        continue;
      }
      if (
        await this.recordExternal(row, {
          kind: 'REFUND',
          currency: refund.currency,
          totalMinorUnits: refund.amountMinorUnits,
          taxMinorUnits: 0,
          externalCreditNoteId: null,
          externalRefundId: refund.externalRefundId,
          detail: `refund ${refund.externalRefundId} without a credit note`,
        })
      ) {
        recorded++;
      }
    }
    return { recorded };
  }

  // A credit note carrying our id for an adjustment that was closed without
  // one (failed, withdrawn, expired, rejected): the provider issued it
  // anyway. Never adopted or reversed; reviewed (once — cases dedupe).
  private async reviewLateNote(
    adjustmentId: string,
    externalCreditNoteId: string,
  ): Promise<void> {
    const adjustment = await this.prisma.billingAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
      include: { invoice: true },
    });
    if (
      adjustment.status === 'SUCCEEDED' ||
      adjustment.externalCreditNoteId === externalCreditNoteId
    ) {
      return;
    }
    await runSerializable(this.prisma, (tx) =>
      this.lifecycle.openCase(
        tx,
        ADJUSTMENT_MISMATCH_CASE,
        adjustment.subscriptionId,
        null,
        `Adjustment ${adjustment.id} is ${adjustment.status}, but the payment provider holds credit note ${externalCreditNoteId} carrying its reference on invoice ${adjustment.invoice.externalInvoiceId}. Money may have moved; nothing was repeated or reversed.`,
      ),
    );
  }

  // Recorded once (unique provider ids), with a review case.
  private async recordExternal(
    row: {
      id: string;
      subscriptionId: string;
      externalInvoiceId: string;
      subscription: { subscriberTenantId: string };
    },
    input: {
      kind: BillingAdjustmentKind;
      currency: string;
      totalMinorUnits: number;
      taxMinorUnits: number;
      externalCreditNoteId: string | null;
      externalRefundId: string | null;
      detail: string;
    },
  ): Promise<boolean> {
    if (input.totalMinorUnits <= 0) return false;
    const existing = await this.prisma.billingAdjustment.count({
      where: input.externalCreditNoteId
        ? { externalCreditNoteId: input.externalCreditNoteId }
        : { externalRefundId: input.externalRefundId },
    });
    if (existing > 0) return false;
    try {
      await runSerializable(this.prisma, async (tx) => {
        const created = await tx.billingAdjustment.create({
          data: {
            subscriptionId: row.subscriptionId,
            invoiceId: row.id,
            origin: 'EXTERNAL',
            kind: input.kind,
            status: 'RECORDED',
            currency: input.currency.toLowerCase(),
            totalMinorUnits: input.totalMinorUnits,
            taxMinorUnits: Math.min(input.taxMinorUnits, input.totalMinorUnits),
            externalCreditNoteId: input.externalCreditNoteId,
            externalRefundId: input.externalRefundId,
            finishedAt: new Date(),
          },
          select: { id: true },
        });
        await this.event(tx, created.id, 'RECORDED', 'EXTERNAL', null);
        await this.lifecycle.openCase(
          tx,
          EXTERNAL_ADJUSTMENT_CASE,
          row.subscriptionId,
          null,
          `A ${input.kind.toLowerCase()} of ${input.totalMinorUnits} ${input.currency} was made directly at the payment provider on invoice ${row.externalInvoiceId} (${input.detail}), not through CENTERIVO. Recorded; nothing was repeated or reversed.`,
        );
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.billingAdjustmentExternalRecorded,
          input.kind,
          row.subscription.subscriberTenantId,
          null,
          undefined,
        );
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  // --- reads -----------------------------------------------------------------------

  private async load(adjustmentId: string): Promise<AdjustmentRow> {
    if (!isUuid(adjustmentId))
      throw new NotFoundException('Adjustment not found.');
    const row = await this.prisma.billingAdjustment.findUnique({
      where: { id: adjustmentId },
      include: ADJUSTMENT_INCLUDE,
    });
    if (!row) throw new NotFoundException('Adjustment not found.');
    return row;
  }

  async detail(adjustmentId: string): Promise<PlatformAdjustmentView> {
    return adjustmentView(await this.load(adjustmentId));
  }

  async list(
    filter: { status: 'OPEN' | 'ALL' } | { tenantId: string },
  ): Promise<PlatformAdjustmentListResponse> {
    if ('tenantId' in filter && !isUuid(filter.tenantId)) {
      throw new NotFoundException('Business not found.');
    }
    const rows = await this.prisma.billingAdjustment.findMany({
      where:
        'tenantId' in filter
          ? { subscription: { subscriberTenantId: filter.tenantId } }
          : filter.status === 'OPEN'
            ? { status: { in: OPEN } }
            : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: ADJUSTMENT_INCLUDE,
    });
    return { adjustments: rows.map(adjustmentView) };
  }

  private async event(
    tx: Tx,
    adjustmentId: string,
    type: string,
    code: string | null,
    actorPlatformOperatorId: string | null,
    note: string | null = null,
  ): Promise<void> {
    await tx.billingAdjustmentEvent.create({
      data: { adjustmentId, type, code, actorPlatformOperatorId, note },
    });
  }

  private async audit(
    tx: Tx,
    action: string,
    reasonCode: string,
    tenantId: string,
    actorPlatformOperatorId: string | null,
    requestReference: string | undefined,
  ): Promise<void> {
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId,
        reasonCode,
        targetType: 'tenant',
        targetId: tenantId,
        requestReference: requestReference ?? null,
      },
    });
  }
}

function codeOf(value: string): string {
  const code = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64);
  return /^[A-Z]/.test(code) ? code : `E_${code}`.slice(0, 64);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: { originalCode?: unknown; code?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    e.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}

export function adjustmentView(row: AdjustmentRow): PlatformAdjustmentView {
  return {
    id: row.id,
    tenantId: row.subscription.subscriberTenantId,
    businessName: row.subscription.subscriberTenant.name,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoice.number,
    origin: row.origin as 'CENTERIVO' | 'EXTERNAL',
    kind: row.kind as BillingAdjustmentKind,
    scope: row.scope as BillingAdjustmentScope | null,
    status: row.status as BillingAdjustmentStatus,
    currency: row.currency.toUpperCase(),
    totalMinorUnits: row.totalMinorUnits,
    taxMinorUnits: row.taxMinorUnits,
    annualFullRefund: row.annualFullRefund,
    requiredApprovals: row.requiredApprovals,
    reason: row.reason,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    decisions: row.decisions.map((decision) => ({
      decision: decision.decision as 'APPROVED' | 'REJECTED',
      note: decision.note,
      operator: decision.operator,
      at: decision.createdAt.toISOString(),
    })),
    events: row.events.map((event) => ({
      type: event.type,
      code: event.code,
      at: event.createdAt.toISOString(),
      actorEmail: event.actor?.email ?? null,
      note: event.note,
    })),
  };
}
