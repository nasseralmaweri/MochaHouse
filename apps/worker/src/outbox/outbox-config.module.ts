import { Module } from '@nestjs/common';
import { hostname } from 'node:os';
import { OUTBOX_CONFIG, loadOutboxConfig } from './outbox.config';

// R1 / S4b — one validated OutboxConfig for the whole worker. A malformed value
// stops the process at startup instead of running with something looser.
@Module({
  providers: [
    {
      provide: OUTBOX_CONFIG,
      useFactory: () => loadOutboxConfig(process.env, hostname()),
    },
  ],
  exports: [OUTBOX_CONFIG],
})
export class OutboxConfigModule {}
