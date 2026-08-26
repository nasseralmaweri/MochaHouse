import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 20;

// Minimal outbox consumer for this slice: claims PENDING OutboxEvent rows
// and marks them PROCESSED, which is what makes an order visible to the
// store queue (AdminOrdersService.listActive, in apps/api, only returns
// orders with a PROCESSED event). There is no external system to dispatch
// to yet, so "processed" here just means "published for store visibility"
// — this is intentionally the smallest possible consumer, not a stand-in
// for a real fulfillment integration.
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

  constructor(private readonly prisma: PrismaService) {}

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
      select: { id: true },
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
    }

    return processedCount;
  }
}
