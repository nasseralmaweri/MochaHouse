import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { NotificationRecipientConfigurationService } from './application/notification-recipient-configuration.service';

// Milestone S0D-2C-3 — tenant-owned notification recipient routing. Mirrors
// tenant-careers-franchising-writes.spec.ts: the service is called directly
// with an explicit TenantContext (never via HTTP), proving the SAME
// invariants PermissionGuard / InternalAuthGuard already enforce generically
// (tested in internal-authorization.spec.ts) don't need re-proving here —
// this file is about the tenant isolation and fail-closed semantics that are
// specific to this feature.
describe('S0D-2C-3 notification recipient routing (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: NotificationRecipientConfigurationService;
  const suffix = randomUUID().slice(0, 8);

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const routingManage = AuthorizationContext.of({
    'notifications.routing.view': corporate,
    'notifications.routing.manage': corporate,
  });

  let actorId: string;
  // Tenant #1 is the real local-dev tenant, so (same reasoning as
  // notification-dispatch.service.spec.ts) every touched Tenant #1 purpose
  // is snapshotted and restored, never left deleted or overwritten.
  const tenant1Snapshots = new Map<string, { email: string } | null>();

  async function snapshotTenant1Once(purpose: string): Promise<void> {
    if (tenant1Snapshots.has(purpose)) {
      return;
    }
    const existing = await prisma.notificationRecipient.findUnique({
      where: { tenantId_purpose: { tenantId: TENANT_1_MOCHA_HOUSE_ID, purpose } },
      select: { email: true },
    });
    tenant1Snapshots.set(purpose, existing);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AuditModule],
      providers: [NotificationRecipientConfigurationService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(NotificationRecipientConfigurationService);
    await prisma.$connect();
    await createTestTenantB(prisma);

    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:s0d2c3-${suffix}`,
        email: `s0d2c3-${suffix}@example.com`,
        displayName: 'S0D2C3 Actor',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    actorId = user.id;
  });

  afterAll(async () => {
    await snapshotTenant1Once('careers.application.received');
    await snapshotTenant1Once('franchising.inquiry.received');
    for (const [purpose, snapshot] of tenant1Snapshots) {
      if (snapshot) {
        await prisma.notificationRecipient.upsert({
          where: {
            tenantId_purpose: { tenantId: TENANT_1_MOCHA_HOUSE_ID, purpose },
          },
          update: { email: snapshot.email },
          create: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            purpose,
            email: snapshot.email,
          },
        });
      } else {
        await prisma.notificationRecipient.deleteMany({
          where: { tenantId: TENANT_1_MOCHA_HOUSE_ID, purpose },
        });
      }
    }
    await prisma.notificationRecipient.deleteMany({
      where: { tenantId: TEST_TENANT_B_ID },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: actorId },
    });
    await prisma.internalUser.deleteMany({ where: { id: actorId } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('list() rejects without notifications.routing.view', async () => {
      await expect(
        service.list(AuthorizationContext.empty(), tenantOne),
      ).rejects.toThrow(ForbiddenException);
    });

    it('update() rejects without notifications.routing.manage', async () => {
      await expect(
        service.update(
          'careers.application.received',
          { email: 'x@example.com' },
          actorId,
          AuthorizationContext.empty(),
          tenantOne,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('validation', () => {
    it('rejects an unknown purpose', async () => {
      await expect(
        service.update(
          'marketing.newsletter',
          { email: 'x@example.com' },
          actorId,
          routingManage,
          tenantOne,
        ),
      ).rejects.toThrow('Unknown notification purpose.');
    });

    it('rejects a malformed email and creates nothing', async () => {
      await snapshotTenant1Once('franchising.inquiry.received');
      await prisma.notificationRecipient.deleteMany({
        where: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          purpose: 'franchising.inquiry.received',
        },
      });

      await expect(
        service.update(
          'franchising.inquiry.received',
          { email: 'not-an-email' },
          actorId,
          routingManage,
          tenantOne,
        ),
      ).rejects.toThrow('A valid recipient email is required.');

      const row = await prisma.notificationRecipient.findUnique({
        where: {
          tenantId_purpose: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            purpose: 'franchising.inquiry.received',
          },
        },
      });
      expect(row).toBeNull();
    });
  });

  describe('list() — missing configuration is a legitimate, visible state', () => {
    it('reports every purpose with email: null when nothing is configured', async () => {
      await snapshotTenant1Once('careers.application.received');
      await snapshotTenant1Once('franchising.inquiry.received');
      await prisma.notificationRecipient.deleteMany({
        where: { tenantId: TENANT_1_MOCHA_HOUSE_ID },
      });

      const result = await service.list(routingManage, tenantOne);
      expect(result.recipients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            purpose: 'careers.application.received',
            email: null,
          }),
          expect.objectContaining({
            purpose: 'franchising.inquiry.received',
            email: null,
          }),
        ]),
      );
    });
  });

  describe('update() — create, update, audit, no-op', () => {
    it('creates a recipient and records an audit event with before: null', async () => {
      await snapshotTenant1Once('careers.application.received');
      await prisma.notificationRecipient.deleteMany({
        where: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          purpose: 'careers.application.received',
        },
      });
      const auditBefore = await prisma.internalAuditEvent.count({
        where: { actorInternalUserId: actorId },
      });

      const result = await service.update(
        'careers.application.received',
        { email: 'hq-careers@example.com' },
        actorId,
        routingManage,
        tenantOne,
      );
      expect(result.email).toBe('hq-careers@example.com');

      const row = await prisma.notificationRecipient.findUniqueOrThrow({
        where: {
          tenantId_purpose: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            purpose: 'careers.application.received',
          },
        },
      });
      expect(row.email).toBe('hq-careers@example.com');

      const event = await prisma.internalAuditEvent.findFirstOrThrow({
        where: {
          actorInternalUserId: actorId,
          action: 'notifications.recipient_updated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(event.targetId).toBe('careers.application.received');
      expect(event.beforeData).toBeNull();
      expect(event.afterData).toEqual({ email: 'hq-careers@example.com' });
      expect(
        await prisma.internalAuditEvent.count({
          where: { actorInternalUserId: actorId },
        }),
      ).toBe(auditBefore + 1);
    });

    it('updates an existing recipient and records before/after', async () => {
      await service.update(
        'careers.application.received',
        { email: 'hq-careers-v2@example.com' },
        actorId,
        routingManage,
        tenantOne,
      );

      const event = await prisma.internalAuditEvent.findFirstOrThrow({
        where: {
          actorInternalUserId: actorId,
          action: 'notifications.recipient_updated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(event.beforeData).toEqual({ email: 'hq-careers@example.com' });
      expect(event.afterData).toEqual({ email: 'hq-careers-v2@example.com' });
    });

    it('is a no-op (no audit event) when the email is unchanged', async () => {
      const auditBefore = await prisma.internalAuditEvent.count({
        where: { actorInternalUserId: actorId },
      });

      await service.update(
        'careers.application.received',
        { email: 'hq-careers-v2@example.com' },
        actorId,
        routingManage,
        tenantOne,
      );

      expect(
        await prisma.internalAuditEvent.count({
          where: { actorInternalUserId: actorId },
        }),
      ).toBe(auditBefore);
    });
  });

  // --- Milestone S0D-2C-3: tenant isolation, structural ------------------
  //
  // Configuration ownership is enforced by the (tenantId, purpose)
  // composite unique key itself, not by an extra runtime check — these
  // tests prove that holds in both directions.

  describe('tenant isolation', () => {
    it("Tenant A's configured recipient is invisible to Tenant B (list)", async () => {
      await snapshotTenant1Once('careers.application.received');
      await service.update(
        'careers.application.received',
        { email: 'tenant-a-careers@example.com' },
        actorId,
        routingManage,
        tenantOne,
      );
      await prisma.notificationRecipient.deleteMany({
        where: {
          tenantId: TEST_TENANT_B_ID,
          purpose: 'careers.application.received',
        },
      });

      const result = await service.list(routingManage, tenantB);
      const careers = result.recipients.find(
        (r) => r.purpose === 'careers.application.received',
      );
      expect(careers?.email).toBeNull();
    });

    it("Tenant A updating its own recipient never touches Tenant B's row, and vice versa", async () => {
      await snapshotTenant1Once('careers.application.received');
      await service.update(
        'careers.application.received',
        { email: 'tenant-a-careers@example.com' },
        actorId,
        routingManage,
        tenantOne,
      );
      await service.update(
        'careers.application.received',
        { email: 'tenant-b-careers@example.com' },
        actorId,
        routingManage,
        tenantB,
      );

      const rowA = await prisma.notificationRecipient.findUniqueOrThrow({
        where: {
          tenantId_purpose: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            purpose: 'careers.application.received',
          },
        },
      });
      const rowB = await prisma.notificationRecipient.findUniqueOrThrow({
        where: {
          tenantId_purpose: {
            tenantId: TEST_TENANT_B_ID,
            purpose: 'careers.application.received',
          },
        },
      });
      expect(rowA.email).toBe('tenant-a-careers@example.com');
      expect(rowB.email).toBe('tenant-b-careers@example.com');

      // Updating Tenant B again must not perturb Tenant A's row.
      await service.update(
        'careers.application.received',
        { email: 'tenant-b-careers-v2@example.com' },
        actorId,
        routingManage,
        tenantB,
      );
      const rowAAfter = await prisma.notificationRecipient.findUniqueOrThrow({
        where: {
          tenantId_purpose: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            purpose: 'careers.application.received',
          },
        },
      });
      expect(rowAAfter.email).toBe('tenant-a-careers@example.com');
    });
  });
});
