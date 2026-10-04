import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  getCurrentTenantContext,
  runWithTenantContext,
} from '@mocha-house/database';
import type { TenantContextRequest } from './tenant-context-request';

// Milestone S0F — carries a GUARD-established TenantContext into the
// async-scoped carrier (diagnostics only — see tenant-context-store.ts).
//
// TenantContextMiddleware puts the context in the carrier itself for the
// routes it resolves. Member routes (/api/v1/admin/*, /api/v1/internal/*)
// get their TenantContext from InternalAuthGuard instead, and a guard
// cannot wrap the rest of the request in the carrier — so this
// interceptor, which runs after every guard and around the handler, does.
//
// It never chooses a tenant: it only mirrors `request.tenantContext`. If
// the carrier already holds a DIFFERENT tenant than the request's context,
// two resolvers disagree about the same request — fail closed.
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    const tenant = request.tenantContext;
    if (!tenant) {
      return next.handle();
    }

    const current = getCurrentTenantContext();
    if (current) {
      if (current.tenantId !== tenant.tenantId) {
        throw new InternalServerErrorException(
          'Conflicting tenant context for this request.',
        );
      }
      return next.handle();
    }

    return new Observable((subscriber) =>
      runWithTenantContext(tenant, () => next.handle().subscribe(subscriber)),
    );
  }
}
