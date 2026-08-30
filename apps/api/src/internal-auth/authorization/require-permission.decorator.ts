import { SetMetadata } from '@nestjs/common';
import type { InternalPermissionKey } from './permission-catalog';

export const REQUIRE_PERMISSION_METADATA = 'internal-auth:require-permission';

// Declares the permission a route requires. The argument is the closed
// InternalPermissionKey union, so a typo is a compile error rather than a
// silently-unenforced route. PermissionGuard reads this metadata; a route
// under PermissionGuard with NO @RequirePermission is denied (fail-closed).
export const RequirePermission = (permission: InternalPermissionKey) =>
  SetMetadata(REQUIRE_PERMISSION_METADATA, permission);
