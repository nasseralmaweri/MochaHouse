import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  createTenantContext,
  TenantContextError,
  type TenantContext,
} from '@mocha-house/database';

// Establishes the TenantContext under which one unit of background work
// runs. Callers hand it the unit of work (an outbox event); they never
// choose a tenant themselves.
//
// Milestone S0D-2C-2 — the event's OWN persisted tenantId is the
// authoritative tenant identity for background processing (OutboxEvent.
// tenantId has been NOT NULL since this milestone, resolved from the
// trusted business aggregate that produced the event — never from the
// worker's SINGLE_TENANT_ID, and never from the event's own JSON payload).
// SINGLE_TENANT_ID remains validated at worker startup (see
// WorkerTenancyModule / single-tenant-resolution.provider.ts) for whatever
// still genuinely needs a process-wide single-tenant assumption; this
// factory no longer reads it — using it here would silently reintroduce
// the exact cross-tenant risk this milestone closes.
@Injectable()
export class WorkerTenantContextFactory {
  // Fails closed: an event with a missing or malformed tenantId refuses to
  // produce a context at all rather than ever falling back to a default.
  forOutboxEvent(event: { id: string; tenantId: string }): TenantContext {
    try {
      return createTenantContext({
        tenantId: event.tenantId,
        principalType: 'worker',
        // Unique per execution, and traceable back to the event it served.
        requestId: `outbox:${event.id}:${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw new TenantContextError(
          `Outbox event ${event.id} has no valid tenant ownership; refusing to process it.`,
        );
      }
      throw error;
    }
  }
}
