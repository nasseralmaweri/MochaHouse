import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

const ENABLE_FLAG = 'ENABLE_DEV_INTERNAL_ORDER_ADMIN';

// DEV-ONLY / INTERNAL PLACEHOLDER — not real security. No Role/Permission
// /Scope infrastructure exists yet, so this guard's only job is to make
// sure that gap fails closed rather than silently allowing traffic
// everywhere, including production.
//
// Access requires BOTH, checked every request (no caching, no "trust the
// last check"):
//   - NODE_ENV is not "production" — an absolute floor. Production always
//     denies, regardless of the flag below, until real authorization
//     exists. This is not overridable by any environment variable.
//   - ENABLE_DEV_INTERNAL_ORDER_ADMIN=true is set explicitly (see
//     apps/api/.env.example). Being non-production is never sufficient by
//     itself — the flag must be turned on deliberately for local/dev use.
//
// Every admin/store route is already wired through this guard and already
// carries a locationId in its path/body, so a real Role/Permission/Scope
// implementation can replace this file's body later without touching the
// controller or service layer at all.
@Injectable()
export class DevInternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    void context;
    const isProduction = process.env.NODE_ENV === 'production';
    const explicitlyEnabled = process.env[ENABLE_FLAG] === 'true';

    if (isProduction || !explicitlyEnabled) {
      throw new ForbiddenException(
        'Internal store/admin order endpoints are disabled. Set ' +
          `${ENABLE_FLAG}=true in a non-production environment to enable ` +
          'them for local development — this is not production security ' +
          'and must never be enabled in production.',
      );
    }

    return true;
  }
}
