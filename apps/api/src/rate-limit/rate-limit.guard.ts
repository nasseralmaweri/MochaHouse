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
  type PolicyDefinition,
  type PolicyName,
  type RateLimitConfig,
  type ScopeDefinition,
} from './rate-limit.config';
import { RATE_LIMIT_POLICY_KEY } from './rate-limit.decorator';
import { RATE_LIMIT_CONFIG, RateLimitService } from './rate-limit.service';

export type RateLimitedRequest = TenantContextRequest &
  CustomerAuthenticatedRequest & { rateLimitReserved?: string[] };

// What the policies may key on, derived once per request. Nothing here comes
// from a client-chosen header: the tenant is the server-resolved context, the
// subject a verified token, the IP either signed or the connection's peer, the
// identifier is hashed, and the order id is the route parameter.
export interface RequestIdentity {
  readonly tenant: string;
  readonly subject: string | null;
  readonly ip: ResolvedClientIp;
  // Hashed; or UNPARSEABLE_IDENTIFIER when the policy needs one and the
  // request did not supply a usable value. null only for policies that do not
  // key on an identifier.
  readonly identifier: string | null;
  readonly order: string | null;
}

// A missing, non-string, empty or oversized identifier is not allowed to skip
// the identifier scopes (that would let a malformed request escape them). All
// such requests share one bucket, so garbage is throttled together and can
// never mint a fresh allowance.
export const UNPARSEABLE_IDENTIFIER = 'unparseable';

export const RATE_LIMIT_MESSAGE =
  'Too many requests. Please wait a moment and try again.';

function bodyField(request: RateLimitedRequest, field: string): unknown {
  const body = request.body as Record<string, unknown> | undefined;
  return body?.[field];
}

// Decides, for one request and one named policy, whether it may proceed — and
// lets a handler give back a reservation when it succeeded. Shared by the guard
// and by handlers that need to report an outcome.
@Injectable()
export class RateLimitEnforcer {
  constructor(
    private readonly service: RateLimitService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  identify(
    request: RateLimitedRequest,
    policy: PolicyDefinition,
  ): RequestIdentity {
    const customer = request.customerIdentity;
    const orderParam = (request.params as Record<string, unknown> | undefined)
      ?.orderId;

    let identifier: string | null = null;
    if (policy.identifierField !== null) {
      // ONLY the field the route's handler acts on is read — never "whichever
      // is present" — so a caller cannot split the bucket from the action.
      identifier =
        hashIdentifier(
          bodyField(request, policy.identifierField),
          process.env.RATE_LIMIT_KEY_PEPPER?.trim() || null,
        ) ?? UNPARSEABLE_IDENTIFIER;
    }

    return {
      tenant: request.tenantContext?.tenantId ?? 'none',
      subject: customer ? `${customer.provider}:${customer.subject}` : null,
      ip: resolveClientIp({
        request,
        mode: this.config.clientIpMode,
        secret: this.config.forwardSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
      identifier,
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
    const identity = this.identify(request, policy);

    // Narrowest scope first; stop at the first refusal so a refused request
    // never counts against a wider (shared) allowance.
    for (const scope of policy.scopes) {
      const key = this.keyFor(policyName, scope, identity);
      if (key === null) continue;

      const decision = await this.service.hit(
        key,
        scope.limit,
        scope.windowSeconds,
      );
      if (scope.mode === 'failure-counter' && decision.allowed) {
        // Reserved: the handler gives it back on success (releaseOnSuccess).
        (request.rateLimitReserved ??= []).push(key);
      }
      if (!decision.allowed) {
        this.service.noteDenial(policyName, scope.name);
        response?.setHeader('Retry-After', String(decision.retryAfterSeconds));
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
  }

  // Gives back every failure-counter reservation this request made: call it when
  // the handler succeeded (for example the guest lookup found its order), so
  // only lookups that did NOT succeed accumulate. Never throws.
  async releaseOnSuccess(request: RateLimitedRequest): Promise<void> {
    const keys = request.rateLimitReserved;
    if (!keys || keys.length === 0) return;
    request.rateLimitReserved = [];
    try {
      for (const key of keys) await this.service.release(key);
    } catch {
      // Best effort; the request already succeeded.
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
