import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { CustomerAuthenticatedRequest } from '../customer-auth/infrastructure/customer-identity';
import type { TenantContextRequest } from '../tenancy/tenant-context-request';
import {
  hashIdentifier,
  resolveClientIp,
  type ResolvedClientIp,
} from './client-identity';
import {
  type KeyPart,
  type PolicyName,
  type RateLimitConfig,
  type ScopeDefinition,
} from './rate-limit.config';
import { RATE_LIMIT_POLICY_KEY } from './rate-limit.decorator';
import { RATE_LIMIT_CONFIG, RateLimitService } from './rate-limit.service';

export type RateLimitedRequest = TenantContextRequest &
  CustomerAuthenticatedRequest;

// What the policies may key on, derived once per request. Nothing here comes
// from a client-chosen header: the tenant is the server-resolved context, the
// subject a verified token, the IP either signed or the connection's peer, the
// identifier is hashed, and the order id is the route parameter.
export interface RequestIdentity {
  readonly tenant: string;
  readonly subject: string | null;
  readonly ip: ResolvedClientIp;
  readonly identifier: string | null;
  readonly order: string | null;
}

export const RATE_LIMIT_MESSAGE =
  'Too many requests. Please wait a moment and try again.';

function bodyIdentifier(request: RateLimitedRequest): unknown {
  const body = request.body as
    { identifier?: unknown; email?: unknown } | undefined;
  return body?.identifier ?? body?.email;
}

// Decides, for one request and one named policy, whether it may proceed — and
// records failures for policies that count them. Shared by the guard and by
// handlers that need to report an outcome (for example a lookup that 404s).
@Injectable()
export class RateLimitEnforcer {
  constructor(
    private readonly service: RateLimitService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  identify(request: RateLimitedRequest): RequestIdentity {
    const customer = request.customerIdentity;
    const orderParam = (request.params as Record<string, unknown> | undefined)
      ?.orderId;
    return {
      tenant: request.tenantContext?.tenantId ?? 'none',
      subject: customer ? `${customer.provider}:${customer.subject}` : null,
      ip: resolveClientIp({
        request,
        mode: this.config.clientIpMode,
        secret: this.config.forwardSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
      identifier: hashIdentifier(
        bodyIdentifier(request),
        process.env.RATE_LIMIT_KEY_PEPPER?.trim() || null,
      ),
      order:
        typeof orderParam === 'string' && orderParam.length > 0
          ? orderParam.slice(0, 64).toLowerCase()
          : null,
    };
  }

  private part(identity: RequestIdentity, part: KeyPart): string | null {
    switch (part) {
      case 'tenant':
        return `t=${identity.tenant}`;
      case 'subject':
        return identity.subject === null ? null : `s=${identity.subject}`;
      case 'ip':
        return identity.ip.ip === null ? null : `ip=${identity.ip.ip}`;
      case 'identifier':
        return identity.identifier === null
          ? null
          : `id=${identity.identifier}`;
      case 'order':
        return identity.order === null ? null : `o=${identity.order}`;
    }
  }

  // The Redis key for a scope, or null when the request lacks something the
  // scope needs (an anonymous request has no subject; an undeclared topology
  // has no trusted IP) — such a scope is skipped, the others still apply.
  keyFor(
    policy: PolicyName,
    scope: ScopeDefinition,
    identity: RequestIdentity,
  ): string | null {
    const authenticated = identity.subject !== null;
    if (scope.appliesTo === 'authenticated' && !authenticated) return null;
    if (scope.appliesTo === 'anonymous' && authenticated) return null;
    const parts: string[] = [];
    for (const keyPart of scope.key) {
      const rendered = this.part(identity, keyPart);
      if (rendered === null) return null;
      parts.push(rendered);
    }
    return `rl:v1:${policy}:${scope.name}:${parts.join('|')}`;
  }

  async enforce(
    request: RateLimitedRequest,
    response: Response | undefined,
    policyName: PolicyName,
  ): Promise<void> {
    if (!this.service.enabled) return;
    const policy = this.config.policies[policyName];
    const identity = this.identify(request);

    let retryAfter = 0;
    const denied: string[] = [];
    for (const scope of policy.scopes) {
      const key = this.keyFor(policyName, scope, identity);
      if (key === null) continue;

      if (scope.mode === 'failure-counter') {
        // Read only: allow while the recorded failures are under the limit.
        const read = await this.service.hit(
          key,
          scope.limit,
          scope.windowSeconds,
          { increment: false },
        );
        if (read.count >= scope.limit) {
          retryAfter = Math.max(retryAfter, read.retryAfterSeconds);
          denied.push(scope.name);
        }
        continue;
      }

      const decision = await this.service.hit(
        key,
        scope.limit,
        scope.windowSeconds,
      );
      if (!decision.allowed) {
        retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
        denied.push(scope.name);
      }
    }

    if (retryAfter > 0) {
      for (const name of denied) this.service.noteDenial(policyName, name);
      response?.setHeader('Retry-After', String(retryAfter));
      // One generic answer for every scope and every reason: nothing about
      // which limit fired, or whether an account or order exists.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: RATE_LIMIT_MESSAGE,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // Adds one to every failure-counter scope of the policy (for example a guest
  // order lookup that did not find an order). Never throws.
  async recordFailure(
    request: RateLimitedRequest,
    policyName: PolicyName,
  ): Promise<void> {
    if (!this.service.enabled) return;
    try {
      const policy = this.config.policies[policyName];
      const identity = this.identify(request);
      for (const scope of policy.scopes) {
        if (scope.mode !== 'failure-counter') continue;
        const key = this.keyFor(policyName, scope, identity);
        if (key === null) continue;
        await this.service.hit(key, scope.limit, scope.windowSeconds);
      }
    } catch {
      // Recording is best-effort; the request already has its answer.
    }
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly enforcer: RateLimitEnforcer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<PolicyName | undefined>(
      RATE_LIMIT_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policy) return true;
    const http = context.switchToHttp();
    await this.enforcer.enforce(
      http.getRequest<RateLimitedRequest>(),
      http.getResponse<Response>(),
      policy,
    );
    return true;
  }
}
