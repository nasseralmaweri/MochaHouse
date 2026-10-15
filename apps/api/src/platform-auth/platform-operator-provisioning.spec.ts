import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  OperatorProvisioningError,
  assertConfirmedDatabase,
  createPlatformOperator,
  listPlatformOperators,
  setPlatformOperatorStatus,
} from '@mocha-house/database/dist/platform/operator-provisioning';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

// SC1a — the provisioning CLI's logic (prisma/scripts/platform-operator.ts)
// against a real database: explicit inputs only, no dev operators in
// production, every change audited in the same transaction, idempotent
// status changes, and a CLI that must name the database it changes.
describe('Platform operator provisioning (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const suffix = randomUUID().slice(0, 8);
  const emails: string[] = [];

  const input = (key: string, overrides: Record<string, unknown> = {}) => {
    const email = `SC1a-Prov-${key}-${suffix}@Example.TEST`;
    emails.push(email.toLowerCase());
    return {
      email,
      externalProvider: 'cognito-platform',
      externalSubject: `sub-${key}-${suffix}`,
      displayName: `Prov ${key}`,
      status: 'ACTIVE',
      ...overrides,
    };
  };
  const audits = (subject: string) =>
    prisma.platformAuditEvent.findMany({
      where: { identitySubject: subject },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    // The audit trail is append-only: leave this run's (uniquely named)
    // operators DISABLED instead of deleting them.
    await prisma.platformOperator.updateMany({
      where: { email: { in: emails } },
      data: { status: 'DISABLED' },
    });
    await moduleRef.close();
  });

  it('creates an operator with the explicit status, a normalised email, and an audit event in the same transaction', async () => {
    const created = await createPlatformOperator(prisma, input('create'));
    expect(created).toMatchObject({
      email: `sc1a-prov-create-${suffix}@example.test`,
      status: 'ACTIVE',
    });
    const events = await audits(`sub-create-${suffix}`);
    expect(events.map((e) => [e.action, e.outcome, e.reasonCode])).toEqual([
      ['platform.operator.created', 'SUCCEEDED', 'CLI'],
    ]);
  });

  it.each([
    ['a missing status', { status: '' }, '--status must be exactly'],
    ['an unknown status', { status: 'active' }, '--status must be exactly'],
    [
      'an unknown provider',
      { externalProvider: 'cognito-internal' },
      '--provider must be one of',
    ],
    ['a blank subject', { externalSubject: '  ' }, '--subject'],
    [
      'an invalid email',
      { email: 'not-an-email' },
      'A valid --email is required.',
    ],
  ])('refuses %s and writes nothing', async (_label, overrides, message) => {
    const before = await prisma.platformOperator.count();
    await expect(
      createPlatformOperator(prisma, input(`bad-${randomUUID()}`, overrides)),
    ).rejects.toThrow(message);
    expect(await prisma.platformOperator.count()).toBe(before);
  });

  it('refuses a duplicate email or identity without creating anything', async () => {
    await createPlatformOperator(prisma, input('dup'));
    await expect(
      createPlatformOperator(prisma, input('dup')),
    ).rejects.toBeInstanceOf(OperatorProvisioningError);
    expect(
      (await audits(`sub-dup-${suffix}`)).filter(
        (e) => e.action === 'platform.operator.created',
      ),
    ).toHaveLength(1);
  });

  it('refuses a platform-dev operator in a production-like environment', async () => {
    await expect(
      createPlatformOperator(
        prisma,
        input('prod-dev', { externalProvider: 'platform-dev' }),
        { NODE_ENV: 'production' },
      ),
    ).rejects.toThrow('cannot be created in a production-like environment');
  });

  it('disables and re-enables idempotently, auditing only real changes', async () => {
    await createPlatformOperator(prisma, input('status'));
    const email = `sc1a-prov-status-${suffix}@example.test`;
    expect(
      (await setPlatformOperatorStatus(prisma, email, 'DISABLED')).changed,
    ).toBe(true);
    expect(
      (await setPlatformOperatorStatus(prisma, email, 'DISABLED')).changed,
    ).toBe(false);
    expect(
      (await setPlatformOperatorStatus(prisma, email.toUpperCase(), 'ACTIVE'))
        .changed,
    ).toBe(true);
    expect((await audits(`sub-status-${suffix}`)).map((e) => e.action)).toEqual(
      [
        'platform.operator.created',
        'platform.operator.disabled',
        'platform.operator.enabled',
      ],
    );
    await expect(
      setPlatformOperatorStatus(
        prisma,
        `nobody-${suffix}@example.test`,
        'ACTIVE',
      ),
    ).rejects.toThrow('No operator has that email.');
  });

  it('lists operators without their identity subject', async () => {
    const listed = await listPlatformOperators(prisma);
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) {
      expect(row).not.toHaveProperty('externalSubject');
    }
  });

  it('the CLI must name the database it changes', () => {
    const url = 'postgresql://u:p@localhost:5433/mocha_target?schema=public';
    expect(() => assertConfirmedDatabase(url, 'mocha_target')).not.toThrow();
    expect(() => assertConfirmedDatabase(url, 'mocha_other')).toThrow(
      '--confirm-database must name the target database exactly.',
    );
    expect(() => assertConfirmedDatabase(url, undefined)).toThrow();
    expect(() => assertConfirmedDatabase(undefined, 'x')).toThrow(
      'DATABASE_URL is not set.',
    );
  });
});
