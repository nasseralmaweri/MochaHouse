import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { runWithTenantContext } from '@mocha-house/database';
import { HttpTenantContextResolver } from './http-tenant-context.resolver';
import type { TenantContextRequest } from './tenant-context-request';

export const REQUEST_ID_HEADER = 'x-request-id';

// Establishes the TenantContext for every API request, before any guard or
// handler runs:
//   1. Generates a server-side request id (an inbound X-Request-Id is never
//      trusted — it would let a client forge log/audit correlation).
//   2. Asks the resolver for the context. The resolver is never given the
//      request, so no client-supplied tenant id (header, query, body) can
//      reach tenant selection.
//   3. Attaches it as `request.tenantContext` (the explicit access path) and
//      runs the rest of the request inside the async-scoped carrier used by
//      diagnostics such as the tenant query audit.
//   4. Echoes the request id so support can correlate a client report with
//      server logs.
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly resolver: HttpTenantContextResolver) {}

  use(request: TenantContextRequest, response: Response, next: NextFunction) {
    const requestId = randomUUID();
    const context = this.resolver.resolve(requestId);

    request.tenantContext = context;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    runWithTenantContext(context, () => next());
  }
}
