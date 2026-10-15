import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from './email/email-sender';
import type { EmailSender } from './email/email-sender';
import { NotificationRecipientResolver } from './notification-recipient-resolver.service';
import {
  renderCareersApplicationReceived,
  renderFranchiseInquiryReceived,
  renderOrderReady,
  renderOrderReceived,
} from './templates';
import type { RenderedEmail, TemplateKey } from './templates';
import {
  EmailProviderRejection,
  PermanentNotificationError,
  SendTimeoutError,
  SuppressedNotification,
} from './delivery-errors';
import { OUTBOX_CONFIG, type OutboxConfig } from '../outbox/outbox.config';
import { orderClosedForReadyNotice } from './order-closed-guard';

// Provider and database errors can quote the recipient's address; error text is
// stored on the delivery and the event and logged, so addresses are removed.
export function redactEmails(text: string): string {
  return text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[email]');
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function eventTypeToTemplateKey(eventType: string): TemplateKey | null {
  switch (eventType) {
    case 'order.checkout.completed':
      return 'order.received';
    case 'order.status.ready':
      return 'order.ready';
    case 'careers.application.submitted':
      return 'careers.application.received';
    case 'franchising.inquiry.submitted':
      return 'franchising.inquiry.received';
    default:
      return null;
  }
}

export interface ClaimedOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  // Milestone S0D-2C-2 — the event's OWN persisted tenant ownership. The
  // sole trusted source for every tenant-scoped lookup below; never read
  // from `payload`, never defaulted.
  tenantId: string;
}

// R1 / S4b — what one delivery ATTEMPT came to. The outbox processor turns this
// into the event's next state; nothing here ever changes OutboxEvent.
export type DispatchOutcome =
  // The event type has no notification: nothing to send.
  | { kind: 'no-handler' }
  // R1 / S5b — deliberately not sent (e.g. READY for an order that has since
  // been rejected or cancelled). The event is complete; nothing was sent.
  | { kind: 'suppressed'; code: string; reason: string }
  // The provider accepted the message (now, or on an earlier attempt whose
  // acceptance was recorded but whose event was not yet marked PROCESSED).
  // "Accepted" is not "delivered to the inbox".
  | { kind: 'accepted'; providerMessageId?: string; alreadyRecorded: boolean }
  // Try again later. `ambiguous` = the provider may already have accepted it.
  | { kind: 'retry'; code: string; reason: string; ambiguous: boolean }
  // Give up: permanent failure. `deliveryMarked` = the delivery row was already
  // marked FAILED (direct callers); when fenced the PROCESSOR marks it, but only
  // after it has dead-lettered the event under its claim.
  | { kind: 'dead'; code: string; reason: string; deliveryMarked: boolean }
  // This attempt no longer owns the event (lease lost): do nothing further.
  | { kind: 'lost-claim' };

// Lets the processor make the "about to send" step conditional on still holding
// the claim, atomically with recording the delivery intent. Absent for direct
// callers (tests, tooling), which then record the intent unconditionally.
// R1 / S5b — beginSend may also answer 'order-closed': the order a READY
// notice is about was rejected or cancelled before the send could start (the
// check runs under a row lock in the same transaction as the intent).
export interface DispatchFence {
  beginSend(
    deliveryId: string,
    flagPossibleDuplicate: boolean,
  ): Promise<boolean | 'order-closed'>;
}

// The order statuses after which a READY notice is stale.
const CLOSED_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'REJECTED',
  'CANCELLED',
]);

interface DeliveryRow {
  id: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  sendStartedAt: Date | null;
  sentAt: Date | null;
  failureReason: string | null;
  possibleDuplicate: boolean;
  providerMessageId: string | null;
}

const ACCEPTANCE_WRITE_ATTEMPTS = 3;
const ACCEPTANCE_RETRY_DELAY_MS = [200, 600];

// Milestone 8H / R1 S4b — the worker's sole owner of notification delivery.
//
// A delivery is one row per (event, channel). The protocol for an attempt:
//   1. If the delivery is already SENT the provider accepted it earlier: report
//      acceptance, never send again.
//   2. If an earlier attempt began a send and never resolved it (sendStartedAt
//      set, no sentAt, no recorded definite failure) its outcome is AMBIGUOUS.
//      One further attempt is allowed and flagged possibleDuplicate; a second
//      ambiguous attempt is escalated (dead letter), not repeated.
//   3. Resolve recipient and render. Permanent problems (nothing to send to,
//      nothing configured, record gone) fail the delivery for good; anything
//      else (a database error) is retried.
//   4. Persist the intent (sendStartedAt), conditional on the claim.
//   5. Call the provider with a timeout and NO database transaction open.
//   6. Record provider acceptance on the delivery BEFORE the processor marks the
//      event PROCESSED. A definite refusal is recorded (failureReason) and clears
//      the ambiguity; a timeout or unknown failure leaves the intent in place.
//
// Exactly-once delivery is NOT provided: if the process dies, or the acceptance
// cannot be recorded, between the provider accepting and step 6 the next attempt
// cannot tell, and (once) re-sends with possibleDuplicate set.
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    private readonly recipients: NotificationRecipientResolver,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  async dispatch(
    event: ClaimedOutboxEvent,
    fence?: DispatchFence,
  ): Promise<DispatchOutcome> {
    const templateKey = eventTypeToTemplateKey(event.eventType);
    if (!templateKey) {
      return { kind: 'no-handler' };
    }

    // 1-2. What an earlier attempt left behind.
    const existing = await this.findDelivery(event);
    if (existing?.status === 'SENT') {
      return {
        kind: 'accepted',
        providerMessageId: existing.providerMessageId ?? undefined,
        alreadyRecorded: true,
      };
    }
    if (existing?.status === 'FAILED') {
      return {
        kind: 'dead',
        code: 'DELIVERY_ALREADY_FAILED',
        reason:
          existing.failureReason ?? 'The delivery was already marked failed.',
        deliveryMarked: true,
      };
    }
    const priorAmbiguous =
      existing !== null &&
      existing.sendStartedAt !== null &&
      existing.sentAt === null &&
      existing.failureReason === null;
    if (priorAmbiguous && existing.possibleDuplicate) {
      const reason =
        'Two sends in a row ended without an answer from the email provider; not sending again. The message may or may not have been delivered.';
      return this.dead(event, templateKey, 'AMBIGUOUS_REPEATED', reason, fence);
    }

    // 3. Resolve recipient and content.
    let recipient: string;
    let rendered: RenderedEmail;
    let fromName: string;
    try {
      const resolved = await this.resolve(event, templateKey);
      recipient = resolved.recipient;
      rendered = resolved.rendered;
      fromName = resolved.businessName;
    } catch (error) {
      if (error instanceof SuppressedNotification) {
        return { kind: 'suppressed', code: error.code, reason: error.message };
      }
      if (error instanceof PermanentNotificationError) {
        this.logger.error(
          `Notification cannot be delivered for outbox event ${event.id} (${event.eventType}): ${error.code}`,
        );
        return this.dead(event, templateKey, error.code, error.message, fence);
      }
      return {
        kind: 'retry',
        code: 'RESOLVE_ERROR',
        reason: this.sanitize(error),
        ambiguous: false,
      };
    }

    // 4. Delivery row and durable intent.
    let delivery: { id: string };
    try {
      delivery =
        existing ?? (await this.createDelivery(event, templateKey, recipient));
    } catch (error) {
      return {
        kind: 'retry',
        code: 'DELIVERY_RECORD_ERROR',
        reason: this.sanitize(error),
        ambiguous: false,
      };
    }
    try {
      const intentRecorded = fence
        ? await fence.beginSend(delivery.id, priorAmbiguous)
        : await this.recordIntentUnfenced(delivery.id, event, priorAmbiguous);
      if (intentRecorded === 'order-closed') {
        return this.suppressClosedOrder(event, delivery.id);
      }
      if (!intentRecorded) {
        return { kind: 'lost-claim' };
      }
    } catch (error) {
      return {
        kind: 'retry',
        code: 'INTENT_RECORD_ERROR',
        reason: this.sanitize(error),
        ambiguous: false,
      };
    }

    // 5. The provider call. No database transaction is open here.
    let providerMessageId: string | undefined;
    try {
      const result = await this.sendWithTimeout({
        to: recipient,
        fromName,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      providerMessageId = result.providerMessageId;
    } catch (error) {
      return this.handleSendFailure(
        event,
        templateKey,
        delivery.id,
        error,
        fence,
      );
    }

    // 6. Record acceptance (before the event becomes PROCESSED).
    const recorded = await this.recordAcceptance(
      delivery.id,
      event.tenantId,
      providerMessageId,
    );
    if (!recorded) {
      // Accepted by the provider but not recorded: the next attempt will see an
      // unresolved intent and (once) re-send, flagged possibleDuplicate.
      this.logger.error(
        `Email accepted by the provider for outbox event ${event.id} but the acceptance could not be recorded; a possible duplicate may follow.`,
      );
      return {
        kind: 'retry',
        code: 'ACCEPTANCE_NOT_RECORDED',
        reason: 'The provider accepted the message but recording that failed.',
        ambiguous: true,
      };
    }
    return { kind: 'accepted', providerMessageId, alreadyRecorded: false };
  }

  // Marks the delivery FAILED (creating the row when none exists, so the failure
  // is visible to operators) — used for permanent failures, exhausted retries
  // and expired events. Never throws.
  async failDelivery(
    event: ClaimedOutboxEvent,
    templateKey: string | null,
    code: string,
    reason: string,
  ): Promise<void> {
    const key = templateKey ?? eventTypeToTemplateKey(event.eventType);
    if (!key) return;
    const failureReason = redactEmails(`${code}: ${reason}`).slice(0, 500);
    try {
      const existing = await this.findDelivery(event);
      if (existing) {
        await this.prisma.notificationDelivery.updateMany({
          where: {
            id: existing.id,
            tenantId: event.tenantId,
            status: 'PENDING',
          },
          data: { status: 'FAILED', failureReason },
        });
        return;
      }
      await this.prisma.notificationDelivery.create({
        data: {
          outboxEventId: event.id,
          channel: 'EMAIL',
          recipient: '(unresolved)',
          templateKey: key,
          status: 'FAILED',
          failureReason,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          tenantId: event.tenantId,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        this.logger.error(
          `Could not record the failed delivery for outbox event ${event.id}: ${this.sanitize(error)}`,
        );
      }
    }
  }

  // True when the provider already accepted this event's message (the delivery
  // is SENT). Whatever else happens to the event, that fact wins: it is
  // completed, never retried or dead-lettered.
  async hasAcceptedDelivery(event: ClaimedOutboxEvent): Promise<boolean> {
    const delivery = await this.findDelivery(event);
    return delivery?.status === 'SENT';
  }

  // ---- internals -------------------------------------------------------

  // A permanent failure. With a fence (the worker) the processor owns terminal
  // state and marks the delivery AFTER dead-lettering the event under its claim,
  // so a stale worker can never flip a delivery another worker is sending.
  // Without one (direct callers, tools) the delivery is marked here.
  private async dead(
    event: ClaimedOutboxEvent,
    templateKey: TemplateKey,
    code: string,
    reason: string,
    fence?: DispatchFence,
  ): Promise<DispatchOutcome> {
    if (!fence) {
      await this.failDelivery(event, templateKey, code, reason);
    }
    return { kind: 'dead', code, reason, deliveryMarked: !fence };
  }

  private async findDelivery(
    event: ClaimedOutboxEvent,
  ): Promise<DeliveryRow | null> {
    return this.prisma.notificationDelivery.findFirst({
      where: {
        outboxEventId: event.id,
        channel: 'EMAIL',
        tenantId: event.tenantId,
      },
      select: {
        id: true,
        status: true,
        sendStartedAt: true,
        sentAt: true,
        failureReason: true,
        possibleDuplicate: true,
        providerMessageId: true,
      },
    });
  }

  private async createDelivery(
    event: ClaimedOutboxEvent,
    templateKey: TemplateKey,
    recipient: string,
  ): Promise<{ id: string }> {
    try {
      return await this.prisma.notificationDelivery.create({
        data: {
          outboxEventId: event.id,
          channel: 'EMAIL',
          recipient,
          templateKey,
          status: 'PENDING',
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          // Milestone S0D-2C-2 — copied from the triggering OutboxEvent, the
          // one authoritative chain. Never independently resolved.
          tenantId: event.tenantId,
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const raced = await this.findDelivery(event);
      if (!raced) throw error;
      return { id: raced.id };
    }
  }

  private async recordIntentUnfenced(
    deliveryId: string,
    event: ClaimedOutboxEvent,
    flagPossibleDuplicate: boolean,
  ): Promise<boolean | 'order-closed'> {
    return this.prisma.$transaction(async (tx) => {
      if (await orderClosedForReadyNotice(tx, event)) {
        return 'order-closed';
      }
      const n = await tx.$executeRaw`
        UPDATE "NotificationDelivery"
           SET "sendStartedAt" = timezone('utc', now()), "failureReason" = NULL,
               "possibleDuplicate" = ("possibleDuplicate" OR ${flagPossibleDuplicate})
         WHERE id = ${deliveryId} AND "tenantId" = ${event.tenantId} AND status = 'PENDING'`;
      return n === 1;
    });
  }

  // The order was closed after the recipient was resolved but before the send
  // could start. The delivery row already exists: it is closed as not sent
  // (with the reason), so nothing ever reads it as an outstanding send.
  private async suppressClosedOrder(
    event: ClaimedOutboxEvent,
    deliveryId: string,
  ): Promise<DispatchOutcome> {
    const reason =
      'The order was rejected or cancelled before this notification was sent.';
    await this.prisma.notificationDelivery
      .updateMany({
        where: { id: deliveryId, tenantId: event.tenantId, status: 'PENDING' },
        data: { status: 'FAILED', failureReason: `ORDER_CLOSED: ${reason}` },
      })
      .catch(() => undefined);
    return { kind: 'suppressed', code: 'ORDER_CLOSED', reason };
  }

  private async sendWithTimeout(
    input: Parameters<EmailSender['send']>[0],
  ): Promise<{ providerMessageId?: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SendTimeoutError(this.config.sendTimeoutMs));
      }, this.config.sendTimeoutMs);
    });
    try {
      return await Promise.race([
        this.emailSender.send({ ...input, abortSignal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleSendFailure(
    event: ClaimedOutboxEvent,
    templateKey: TemplateKey,
    deliveryId: string,
    error: unknown,
    fence?: DispatchFence,
  ): Promise<DispatchOutcome> {
    if (error instanceof EmailProviderRejection) {
      // The provider answered and refused: definitely not sent. Record that, which
      // also clears the "unresolved intent" ambiguity for the next attempt.
      const reason = this.sanitize(error);
      if (error.retryable) {
        await this.prisma.notificationDelivery
          .updateMany({
            where: {
              id: deliveryId,
              tenantId: event.tenantId,
              status: 'PENDING',
            },
            data: {
              failureReason: redactEmails(`${error.code}: ${reason}`).slice(
                0,
                500,
              ),
            },
          })
          .catch(() => undefined);
        return { kind: 'retry', code: error.code, reason, ambiguous: false };
      }
      return this.dead(event, templateKey, error.code, reason, fence);
    }
    // No answer from the provider (timeout, connection loss, unknown failure):
    // it may have been accepted. The intent stays unresolved on purpose.
    const timedOut = error instanceof SendTimeoutError;
    return {
      kind: 'retry',
      code: timedOut ? 'SEND_TIMEOUT' : 'SEND_OUTCOME_UNKNOWN',
      reason: this.sanitize(error),
      ambiguous: true,
    };
  }

  private async recordAcceptance(
    deliveryId: string,
    tenantId: string,
    providerMessageId: string | undefined,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < ACCEPTANCE_WRITE_ATTEMPTS; attempt += 1) {
      try {
        // Not fenced by the lease on purpose: the provider DID accept, and that
        // fact must be recorded even if the claim has since been lost.
        // The status is not part of the WHERE on purpose: the provider accepted
        // the message, so SENT is the truth even if something else marked the
        // delivery otherwise in the meantime. A row count of 0 means the delivery
        // is gone, which is NOT a recorded acceptance.
        const updated = await this.prisma.notificationDelivery.updateMany({
          where: { id: deliveryId, tenantId },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            providerMessageId: providerMessageId ?? null,
            failureReason: null,
          },
        });
        if (updated.count === 1) return true;
      } catch {
        const delay = ACCEPTANCE_RETRY_DELAY_MS[attempt];
        if (delay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    return false;
  }

  private async resolve(
    event: ClaimedOutboxEvent,
    templateKey: TemplateKey,
  ): Promise<{
    recipient: string;
    rendered: RenderedEmail;
    businessName: string;
  }> {
    const businessName = await this.businessName(event.tenantId);
    switch (templateKey) {
      case 'order.received':
      case 'order.ready': {
        // Milestone S0D-2C-2 — the tenant predicate is the event's own
        // persisted ownership, never AsyncLocalStorage, never payload: a
        // Tenant A event must never resolve a Tenant B Order even if the
        // id happened to be guessable.
        const order = await this.prisma.order.findUnique({
          where: { id: event.aggregateId, tenantId: event.tenantId },
          select: {
            orderNumber: true,
            status: true,
            guestEmail: true,
            location: { select: { name: true } },
            customer: { select: { email: true } },
          },
        });
        if (!order) {
          throw new PermanentNotificationError(
            'ORDER_NOT_FOUND',
            'Order not found for notification dispatch.',
          );
        }
        // R1 / S5b — "your order is ready" for an order the shop has since
        // rejected or cancelled is false: never sent. (Checked again under a
        // row lock when the send begins; see orderClosedForReadyNotice.)
        if (
          templateKey === 'order.ready' &&
          CLOSED_ORDER_STATUSES.has(order.status)
        ) {
          throw new SuppressedNotification(
            'ORDER_CLOSED',
            'The order was rejected or cancelled; its ready notification is not sent.',
          );
        }
        // Authoritative recipient: a signed-in customer's account email
        // takes precedence over the guest-checkout snapshot, matching how
        // the rest of the Order domain treats customerId as the source of
        // truth when present (see Order.guestEmail's own doc comment).
        const recipient = order.customer?.email ?? order.guestEmail;
        if (!recipient) {
          throw new PermanentNotificationError(
            'NO_RECIPIENT',
            'No recipient email available for this order.',
          );
        }
        const rendered =
          templateKey === 'order.received'
            ? renderOrderReceived({
                businessName,
                orderNumber: order.orderNumber,
                locationName: order.location.name,
              })
            : renderOrderReady({
                businessName,
                orderNumber: order.orderNumber,
                locationName: order.location.name,
              });
        return { recipient, rendered, businessName };
      }
      case 'careers.application.received': {
        // Milestone S0D-2C-3 — tenant-owned routing, resolved from the
        // event's own tenantId. No fallback to a global env var or to any
        // other tenant's configuration: a tenant with nothing configured
        // fails this notification closed.
        const recipient = await this.recipients.resolve(
          event.tenantId,
          'careers.application.received',
        );
        if (!recipient) {
          throw new PermanentNotificationError(
            'RECIPIENT_NOT_CONFIGURED',
            'No Careers notification recipient is configured for this tenant.',
          );
        }
        // Milestone S0D-2C-2 — tenant-scoped: a Tenant A event must never
        // resolve a Tenant B JobApplication.
        const application = await this.prisma.jobApplication.findUnique({
          where: { id: event.aggregateId, tenantId: event.tenantId },
          select: { firstName: true, lastName: true, jobTitleSnapshot: true },
        });
        if (!application) {
          throw new PermanentNotificationError(
            'AGGREGATE_NOT_FOUND',
            'Job application not found for notification dispatch.',
          );
        }
        const rendered = renderCareersApplicationReceived({
          applicantName: `${application.firstName} ${application.lastName}`,
          jobTitleSnapshot: application.jobTitleSnapshot,
        });
        return { recipient, rendered, businessName };
      }
      case 'franchising.inquiry.received': {
        // Milestone S0D-2C-3 — tenant-owned routing (see above).
        const recipient = await this.recipients.resolve(
          event.tenantId,
          'franchising.inquiry.received',
        );
        if (!recipient) {
          throw new PermanentNotificationError(
            'RECIPIENT_NOT_CONFIGURED',
            'No Franchising notification recipient is configured for this tenant.',
          );
        }
        // Milestone S0D-2C-2 — tenant-scoped: a Tenant A event must never
        // resolve a Tenant B FranchiseInquiry.
        const inquiry = await this.prisma.franchiseInquiry.findUnique({
          where: { id: event.aggregateId, tenantId: event.tenantId },
          select: { firstName: true, lastName: true, preferredMarket: true },
        });
        if (!inquiry) {
          throw new PermanentNotificationError(
            'AGGREGATE_NOT_FOUND',
            'Franchise inquiry not found for notification dispatch.',
          );
        }
        const rendered = renderFranchiseInquiryReceived({
          inquirerName: `${inquiry.firstName} ${inquiry.lastName}`,
          preferredMarket: inquiry.preferredMarket,
        });
        return { recipient, rendered, businessName };
      }
    }
  }

  // Security 4A — the sending business's display name, from the event's own
  // tenant (the one authoritative ownership chain), never a hardcoded brand
  // and never another tenant's. A tenant that cannot be read fails the
  // notification closed rather than sending under some other name.
  private async businessName(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const name = tenant?.name.trim();
    if (!name) {
      throw new PermanentNotificationError(
        'BUSINESS_NAME_MISSING',
        'Business name is not available for this tenant.',
      );
    }
    return name;
  }

  // Bounded and stripped of stack traces before ever reaching the
  // database, same convention as
  // CheckoutService.markReconciliationRequired's reconciliationReason.
  private sanitize(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return redactEmails(message).slice(0, 500);
  }
}
