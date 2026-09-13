import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from './email/email-sender';
import type { EmailSender } from './email/email-sender';
import {
  renderCareersApplicationReceived,
  renderFranchiseInquiryReceived,
  renderOrderReady,
  renderOrderReceived,
} from './templates';
import type { RenderedEmail, TemplateKey } from './templates';

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
}

// Milestone 8H — the worker's sole owner of notification delivery. Called
// by OutboxProcessorService for every OutboxEvent it claims, AFTER that
// claim (the PENDING -> PROCESSED conditional update) has already
// succeeded. Nothing here ever affects OutboxEvent.status: whatever
// happens in dispatch(), the event that was claimed stays PROCESSED — see
// outbox-processor.service.ts for why that must never depend on email
// outcome (Store Queue visibility reads that same status).
//
// Idempotency: the very first thing this does for a recognized event is an
// INSERT into NotificationDelivery guarded by the (outboxEventId, channel)
// unique constraint. That insert is the real claim on "send this specific
// notification" — if it fails with P2002, some other attempt (a duplicate
// claim, a re-run) already owns this event+channel and this call returns
// without sending anything. No general retry: a FAILED row is left FAILED,
// exactly like PaymentAttempt.reconciliationRequired never auto-retries —
// it is a manual-review signal, not a queue to drain again.
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
  ) {}

  async dispatch(event: ClaimedOutboxEvent): Promise<void> {
    const templateKey = eventTypeToTemplateKey(event.eventType);
    if (!templateKey) {
      return;
    }

    let recipient: string;
    let rendered: RenderedEmail | null = null;
    let resolutionError: string | null = null;
    try {
      const resolved = await this.resolve(event, templateKey);
      recipient = resolved.recipient;
      rendered = resolved.rendered;
    } catch (error) {
      recipient = '(unresolved)';
      resolutionError = this.sanitize(error);
    }

    let delivery: { id: string };
    try {
      delivery = await this.prisma.notificationDelivery.create({
        data: {
          outboxEventId: event.id,
          channel: 'EMAIL',
          recipient,
          templateKey,
          status: 'PENDING',
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        this.logger.warn(
          `Notification already attempted for outbox event ${event.id}; skipping duplicate send.`,
        );
        return;
      }
      throw error;
    }

    if (resolutionError || !rendered) {
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', failureReason: resolutionError },
      });
      this.logger.error(
        `Notification dispatch could not be prepared for outbox event ${event.id} (${event.eventType}): ${resolutionError}`,
      );
      return;
    }

    try {
      const result = await this.emailSender.send({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
        },
      });
    } catch (error) {
      const reason = this.sanitize(error);
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', failureReason: reason },
      });
      this.logger.error(
        `Notification send failed for outbox event ${event.id} (${event.eventType}, template ${templateKey}): ${reason}`,
      );
    }
  }

  private async resolve(
    event: ClaimedOutboxEvent,
    templateKey: TemplateKey,
  ): Promise<{ recipient: string; rendered: RenderedEmail }> {
    switch (templateKey) {
      case 'order.received':
      case 'order.ready': {
        const order = await this.prisma.order.findUnique({
          where: { id: event.aggregateId },
          select: {
            orderNumber: true,
            guestEmail: true,
            location: { select: { name: true } },
            customer: { select: { email: true } },
          },
        });
        if (!order) {
          throw new Error('Order not found for notification dispatch.');
        }
        // Authoritative recipient: a signed-in customer's account email
        // takes precedence over the guest-checkout snapshot, matching how
        // the rest of the Order domain treats customerId as the source of
        // truth when present (see Order.guestEmail's own doc comment).
        const recipient = order.customer?.email ?? order.guestEmail;
        if (!recipient) {
          throw new Error('No recipient email available for this order.');
        }
        const rendered =
          templateKey === 'order.received'
            ? renderOrderReceived({
                orderNumber: order.orderNumber,
                locationName: order.location.name,
              })
            : renderOrderReady({
                orderNumber: order.orderNumber,
                locationName: order.location.name,
              });
        return { recipient, rendered };
      }
      case 'careers.application.received': {
        const recipient = process.env.CAREERS_NOTIFICATION_EMAIL;
        if (!recipient) {
          throw new Error('CAREERS_NOTIFICATION_EMAIL is not configured.');
        }
        const application = await this.prisma.jobApplication.findUnique({
          where: { id: event.aggregateId },
          select: { firstName: true, lastName: true, jobTitleSnapshot: true },
        });
        if (!application) {
          throw new Error('Job application not found for notification dispatch.');
        }
        const rendered = renderCareersApplicationReceived({
          applicantName: `${application.firstName} ${application.lastName}`,
          jobTitleSnapshot: application.jobTitleSnapshot,
        });
        return { recipient, rendered };
      }
      case 'franchising.inquiry.received': {
        const recipient = process.env.FRANCHISING_NOTIFICATION_EMAIL;
        if (!recipient) {
          throw new Error('FRANCHISING_NOTIFICATION_EMAIL is not configured.');
        }
        const inquiry = await this.prisma.franchiseInquiry.findUnique({
          where: { id: event.aggregateId },
          select: { firstName: true, lastName: true, preferredMarket: true },
        });
        if (!inquiry) {
          throw new Error('Franchise inquiry not found for notification dispatch.');
        }
        const rendered = renderFranchiseInquiryReceived({
          inquirerName: `${inquiry.firstName} ${inquiry.lastName}`,
          preferredMarket: inquiry.preferredMarket,
        });
        return { recipient, rendered };
      }
    }
  }

  // Bounded and stripped of stack traces before ever reaching the
  // database, same convention as
  // CheckoutService.markReconciliationRequired's reconciliationReason.
  private sanitize(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return message.slice(0, 500);
  }
}
