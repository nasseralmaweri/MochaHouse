import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 20;

// Outbox consumer: claims PENDING OutboxEvent rows and marks them
// PROCESSED, which is what makes an order visible to the store queue
// (AdminOrdersService.listActive, in apps/api, only returns orders with a
// PROCESSED event). Milestone 8H added a second effect of that same claim:
// for eventTypes NotificationDispatchService recognizes, it attempts to
// send a notification — but this is deliberately bolted onto the existing
// claim rather than a second consumer polling the same table, because two
// independent consumers racing to claim the same PENDING row would mean
// only one of them ever gets to act on it. Store-queue visibility and
// notification dispatch are two ordinary side effects of "this worker
// process claimed this event", not two competing owners of it.
//
// Lives here (apps/worker), not apps/api: the approved architecture
// assigns asynchronous/background execution to the worker. apps/api stays
// synchronous request/response only — it reads OutboxEvent.status to
// decide store-queue visibility, but never claims or advances it. Both
// apps share the same Prisma schema/client via @mocha-house/database
// (packages/database) rather than each owning their own database model.
// PostgreSQL polling is acceptable for this local/initial slice; a real
// queue/SQS between outbox and consumer is the natural next step once
// there's an actual external system on the other end.
@Injectable()
export class OutboxProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatchService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.processPendingBatch().catch((error: unknown) => {
        this.logger.error('Outbox processing batch failed', error);
      });
    }, DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  // The actual unit of work, exposed separately from the timer so it can
  // be invoked directly (tests, or a future manual "process now" trigger)
  // without waiting on wall-clock time.
  async processPendingBatch(batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true, aggregateType: true, aggregateId: true, eventType: true },
    });

    let processedCount = 0;
    for (const event of pending) {
      // A conditional UPDATE, not a plain one: guards against a second
      // worker instance (or a second concurrent poll tick) claiming the
      // same event twice. At-least-once delivery is assumed — this WHERE
      // clause is what makes processing idempotent rather than relying on
      // there only ever being one consumer.
      const result = await this.prisma.outboxEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      processedCount += result.count;

      if (result.count === 0) {
        // Lost the claim race — some other call already owns this event.
        continue;
      }

      // Deliberately AFTER the update above, and deliberately never able
      // to affect it: this event is PROCESSED no matter what happens next.
      // A thrown error here would otherwise still leave a caught rejection
      // in the outer .catch() (see onModuleInit) rather than ever
      // resurrecting the event or blocking the batch — but
      // NotificationDispatchService itself is written to never throw for
      // an expected failure (a bad recipient, a send error); this try/catch
      // is only a backstop against a genuinely unexpected bug in it.
      try {
        await this.notifications.dispatch(event);
      } catch (error) {
        this.logger.error(
          `Notification dispatch threw unexpectedly for outbox event ${event.id} (${event.eventType})`,
          error,
        );
      }
    }

    return processedCount;
  }
}
