import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from '@mocha-house/contracts';

// SC3e-2 — tests only: grants a scratch-database operator the platform
// permissions a spec exercises (in real environments only the provisioning
// CLI grants them). Nothing here is reachable from the API.
export async function grantPlatformPermissions(
  prisma: {
    platformOperatorPermission: {
      createMany(args: {
        data: { operatorId: string; permission: string; grantReason: string }[];
      }): Promise<unknown>;
    };
  },
  operatorId: string,
  permissions: readonly PlatformPermission[] = PLATFORM_PERMISSIONS,
): Promise<void> {
  await prisma.platformOperatorPermission.createMany({
    data: permissions.map((permission) => ({
      operatorId,
      permission,
      grantReason: 'Test fixture: scratch-database operator',
    })),
  });
}
