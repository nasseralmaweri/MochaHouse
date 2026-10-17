import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from '@mocha-house/contracts';

// SC3e-2 — tests only: grants a scratch-database operator the platform
// permissions a spec exercises (in real environments only the provisioning
// CLI grants them). Nothing here is reachable from the API.
// SC3e-3 — the database refuses a plain CLI grant of a financial permission,
// so those are recorded as a (test) bootstrap.
const FINANCIAL: readonly string[] = [
  'billing.adjustments.request',
  'billing.adjustments.approve',
  'platform.permissions.manage',
];

export async function grantPlatformPermissions(
  prisma: {
    platformOperatorPermission: {
      createMany(args: {
        data: {
          operatorId: string;
          permission: string;
          grantReason: string;
          grantedVia?: string;
          approvalReference?: string | null;
          executedBy?: string | null;
        }[];
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
      ...(FINANCIAL.includes(permission)
        ? {
            grantedVia: 'CLI_BOOTSTRAP',
            approvalReference: 'TEST-FIXTURE',
            executedBy: 'test-fixture',
          }
        : {}),
    })),
  });
}
