import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  createTenantContext,
  type SingleTenantResolution,
  type TenantContext,
} from '@mocha-house/database';
import { SINGLE_TENANT_RESOLUTION } from './single-tenant-resolution.provider';

// Establishes the TenantContext under which one unit of background work
// runs. Callers hand it the unit of work (an outbox event); they never
// choose a tenant themselves.
//
// S0C: every event belongs to the single tenant validated at startup,
// because OutboxEvent has no tenantId yet. S0I changes ONLY this factory to
// read the event's own tenantId (and to refuse an event without one) —
// callers and the context shape stay the same.
@Injectable()
export class WorkerTenantContextFactory {
  constructor(
    @Inject(SINGLE_TENANT_RESOLUTION)
    private readonly resolution: SingleTenantResolution,
  ) {}

  forOutboxEvent(event: { id: string }): TenantContext {
    return createTenantContext({
      tenantId: this.resolution.tenantId,
      principalType: 'worker',
      // Unique per execution, and traceable back to the event it served.
      requestId: `outbox:${event.id}:${randomUUID()}`,
    });
  }
}
