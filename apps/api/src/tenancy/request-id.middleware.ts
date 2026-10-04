import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { TenantContextRequest } from './tenant-context-request';

export const REQUEST_ID_HEADER = 'x-request-id';

// Assigns every API request a server-side request id, before any tenant
// resolution and on EVERY route (including the member routes whose tenant
// is resolved later by InternalAuthGuard):
//   - an inbound X-Request-Id is never trusted — it would let a client
//     forge log/audit correlation;
//   - the id is echoed so support can correlate a client report with
//     server logs.
// Split out of TenantContextMiddleware in Milestone S0F, when that
// middleware stopped running on authenticated internal routes.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: TenantContextRequest, response: Response, next: NextFunction) {
    const requestId = randomUUID();
    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
