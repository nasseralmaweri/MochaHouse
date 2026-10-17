import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  PlatformOperatorDirectoryResponse,
  PlatformPermission,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import {
  bootstrapFinancialPermission,
  grantPlatformPermission,
} from '@mocha-house/database/dist/platform/operator-provisioning';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signPlatformDevJwt } from './infrastructure/platform-dev-jwt';

// SC3e-3 (owner decision D7) — granting operator permissions:
//   * the plain CLI never grants a financial permission (also refused by
//     the database);
//   * the one-time bootstrap records an approval reference and the
//     executing account, and closes once an active operator holds
//     platform.permissions.manage;
//   * afterwards, only an operator holding platform.permissions.manage
//     grants or revokes them in the console — never for itself (also refused
//     by the database), with a recent sign-in and a reason, audited;
//   * no self-granting of anything through the API.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);

jest.setTimeout(180_000);

describe('SC3e-3 operator permission grants (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3e3p-platform-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const ids: Record<string, string> = {};
  const emailOf = (key: string) => `sc3e3p-${key}-${run}@example.test`;

  async function operator(
    key: string,
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3e3p-${key}-${run}`,
        email: emailOf(key),
        status,
      },
    });
    ids[key] = row.id;
    return row.id;
  }
  const asOperator = (
    key: string,
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    signedInSecondsAgo = 0,
  ) => {
    const token = signPlatformDevJwt(
      {
        sub: `platform-dev:sc3e3p-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${token}`);
    return body !== undefined ? req.send(body as object) : req;
  };
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;
  const change = (
    actor: string,
    target: string,
    permission: PlatformPermission,
    step: 'grant' | 'revoke' = 'grant',
    signedInSecondsAgo = 0,
  ) =>
    asOperator(
      actor,
      'post',
      `/operators/${ids[target]}/permissions${step === 'revoke' ? '/revoke' : ''}`,
      { permission, reason: 'Joined the billing approvals rota.' },
      signedInSecondsAgo,
    );
  const bootstrap = (
    key: string,
    permission: string,
    approvalReference: string | undefined = 'CHG-2026-1042',
  ) =>
    bootstrapFinancialPermission(prisma, {
      email: emailOf(key),
      permission,
      reason: 'Initial billing approver, approved by the board.',
      approvalReference,
      executedBy: 'ops-admin@build-host',
    });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e3_permissions',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    for (const key of ['root', 'second', 'member', 'plain']) {
      await operator(key);
    }
    await operator('off', 'DISABLED');
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('the plain CLI never grants a financial permission; the database refuses it too', async () => {
    for (const permission of [
      'billing.adjustments.request',
      'billing.adjustments.approve',
      'platform.permissions.manage',
    ]) {
      await expect(
        grantPlatformPermission(prisma, {
          email: emailOf('plain'),
          permission,
          reason: 'Trying the ordinary grant.',
        }),
      ).rejects.toThrow(/bootstrap|Platform Console/);
      await expect(
        prisma.platformOperatorPermission.create({
          data: {
            operatorId: ids.plain,
            permission,
            grantReason: 'Written directly.',
          },
        }),
      ).rejects.toThrow();
    }
    // A console grant must name its grantor, never the holder itself.
    await expect(
      prisma.platformOperatorPermission.create({
        data: {
          operatorId: ids.plain,
          permission: 'billing.adjustments.approve',
          grantReason: 'Written directly.',
          grantedVia: 'CONSOLE',
          grantedByOperatorId: ids.plain,
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.platformOperatorPermission.count({
        where: { operatorId: ids.plain },
      }),
    ).toBe(0);
  });

  it('the bootstrap needs an approval reference, records who ran it, and closes once a manager exists', async () => {
    await expect(bootstrap('root', 'billing.cases.manage')).rejects.toThrow(
      /only for the financial permissions/,
    );
    await expect(
      bootstrap('root', 'platform.permissions.manage', ''),
    ).rejects.toThrow(/--approval-reference is required/);
    await expect(
      bootstrap('off', 'platform.permissions.manage'),
    ).rejects.toThrow(/ACTIVE/);
    const first = await bootstrap('root', 'platform.permissions.manage');
    expect(first.changed).toBe(true);
    const row = await prisma.platformOperatorPermission.findFirstOrThrow({
      where: {
        operatorId: ids.root,
        permission: 'platform.permissions.manage',
      },
    });
    expect(row).toMatchObject({
      grantedVia: 'CLI_BOOTSTRAP',
      approvalReference: 'CHG-2026-1042',
      executedBy: 'ops-admin@build-host',
      grantedByOperatorId: null,
    });
    // Its provenance never changes.
    await expect(
      prisma.platformOperatorPermission.update({
        where: { id: row.id },
        data: { approvalReference: 'SOMETHING-ELSE' },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.operator.permission_bootstrapped',
          targetId: ids.root,
        },
      }),
    ).toBe(1);
    // Closed now.
    await expect(
      bootstrap('second', 'billing.adjustments.approve'),
    ).rejects.toThrow(/bootstrap is closed/);
  });

  it('a manager grants and revokes in the console — never for itself; recent sign-in and a reason; audited', async () => {
    // Without platform.permissions.manage: refused (and the directory too).
    expect(
      codeOf(
        await change('member', 'second', 'billing.adjustments.approve').expect(
          403,
        ),
      ),
    ).toBe('PLATFORM_PERMISSION_REQUIRED');
    await asOperator('member', 'get', '/operators').expect(403);
    // Never for itself.
    expect(
      codeOf(
        await change('root', 'root', 'billing.adjustments.approve').expect(409),
      ),
    ).toBe('PLATFORM_PERMISSION_SELF');
    // A recent sign-in and a reason.
    expect(
      codeOf(
        await change(
          'root',
          'second',
          'billing.adjustments.approve',
          'grant',
          3600,
        ).expect(401),
      ),
    ).toBe('REAUTHENTICATION_REQUIRED');
    await asOperator('root', 'post', `/operators/${ids.second}/permissions`, {
      permission: 'billing.adjustments.approve',
    }).expect(400);
    await asOperator('root', 'post', `/operators/${ids.second}/permissions`, {
      permission: 'billing.everything',
      reason: 'Joined the billing approvals rota.',
    }).expect(400);
    // Only an active operator.
    expect(
      codeOf(
        await change('root', 'off', 'billing.adjustments.approve').expect(409),
      ),
    ).toBe('PLATFORM_OPERATOR_NOT_ACTIVE');

    const directory = (
      await change('root', 'second', 'billing.adjustments.approve').expect(200)
    ).body as PlatformOperatorDirectoryResponse;
    expect(
      directory.operators.find((o) => o.id === ids.second)!.permissions,
    ).toEqual([
      expect.objectContaining({
        permission: 'billing.adjustments.approve',
        grantedVia: 'CONSOLE',
        grantedBy: { id: ids.root, email: emailOf('root') },
      }),
    ]);
    // Idempotent.
    await change('root', 'second', 'billing.adjustments.approve').expect(200);
    expect(
      await prisma.platformOperatorPermission.count({
        where: { operatorId: ids.second, revokedAt: null },
      }),
    ).toBe(1);

    // A second manager, granted by the first; it can't grant itself more.
    await change('root', 'second', 'platform.permissions.manage').expect(200);
    expect(
      codeOf(
        await change('second', 'second', 'billing.adjustments.request').expect(
          409,
        ),
      ),
    ).toBe('PLATFORM_PERMISSION_SELF');
    // ...but it can revoke the first's (never its own).
    await change('second', 'member', 'billing.adjustments.request').expect(200);
    await change(
      'second',
      'member',
      'billing.adjustments.request',
      'revoke',
    ).expect(200);
    const revoked = await prisma.platformOperatorPermission.findFirstOrThrow({
      where: {
        operatorId: ids.member,
        permission: 'billing.adjustments.request',
      },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedByOperatorId).toBe(ids.second);
    expect(
      codeOf(
        await change(
          'second',
          'second',
          'platform.permissions.manage',
          'revoke',
        ).expect(409),
      ),
    ).toBe('PLATFORM_PERMISSION_SELF');

    expect(
      (
        await prisma.platformAuditEvent.findMany({
          where: {
            action: { startsWith: 'platform.operator.permission_' },
            targetId: { in: [ids.second, ids.member] },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            action: true,
            reasonCode: true,
            actorPlatformOperatorId: true,
          },
        })
      ).map((e) => `${e.action}:${e.reasonCode}`),
    ).toEqual([
      'platform.operator.permission_granted:BILLING_ADJUSTMENTS_APPROVE',
      'platform.operator.permission_granted:PLATFORM_PERMISSIONS_MANAGE',
      'platform.operator.permission_granted:BILLING_ADJUSTMENTS_REQUEST',
      'platform.operator.permission_revoked:BILLING_ADJUSTMENTS_REQUEST',
    ]);
    // The bootstrap never reopens, even with every manager revoked or
    // disabled.
    await prisma.platformOperatorPermission.updateMany({
      where: { permission: 'platform.permissions.manage', revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokeReason: 'Testing the closed bootstrap.',
      },
    });
    await prisma.platformOperator.updateMany({
      where: { id: { in: [ids.root, ids.second] } },
      data: { status: 'DISABLED' },
    });
    await expect(
      bootstrap('member', 'platform.permissions.manage'),
    ).rejects.toThrow(/bootstrap is closed/);
  });
});
