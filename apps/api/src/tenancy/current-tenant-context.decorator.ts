import {
  createParamDecorator,
  InternalServerErrorException,
  type ExecutionContext,
} from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import type { TenantContextRequest } from './tenant-context-request';

// Hands a controller the request's TenantContext. Fails closed: a request
// that somehow reached a handler without one is a server misconfiguration,
// and the handler never runs without a tenant.
export const CurrentTenantContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    if (!request.tenantContext) {
      throw new InternalServerErrorException(
        'Tenant context is not established for this request.',
      );
    }
    return request.tenantContext;
  },
);
