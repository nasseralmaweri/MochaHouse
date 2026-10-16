import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  InternalBusinessesResponse,
  InternalMeResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { LocationsModule } from '../locations/locations.module';
import { InternalAuthModule } from './internal-auth.module';
import { signInternalDevJwt } from './infrastructure/internal-dev-jwt';

// SC1d — staff identity matching ignores email letter case, with every
// existing safeguard kept:
//   - rows already bound to a login are matched by subject only, never by
//     email, and are never re-bound, merged or reassigned;
//   - first-time binding needs a VERIFIED email and an ACTIVE row;
//   - binding is scoped to the one business being entered (and to the same
//     identity provider);
//   - two or more unbound rows in one business that differ only by case are
//     ambiguous: nothing binds and the business is not offered;
//   - `_` and `%` in an address are never wildcards;
//   - the stored email is never rewritten by a sign-in.
// Mocha House (Tenant #1) staff are covered explicitly.
describe('SC1d staff email case-insensitive binding (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const secret = `sc1d-internal-${randomUUID()}`;
  const suffix = randomUUID().slice(0, 8);
  const MOCHA = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;
  const userIds: string[] = [];

  // An address unique to this run; `local` may carry any letter case.
  const address = (local: string) => `${local}-${suffix}@Example.COM`;

  async function staff(
    tenantId: string,
    email: string,
    opts: {
      status?: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DISABLED';
      subject?: string | null;
      provider?: string;
    } = {},
  ) {
    const row = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: opts.provider ?? 'internal-dev',
        externalSubject: opts.subject ?? null,
        email,
        status: opts.status ?? 'ACTIVE',
        activatedAt: opts.status === 'INVITED' ? null : new Date(),
      },
    });
    userIds.push(row.id);
    return row;
  }

  const tokenFor = (subject: string, email: string, emailVerified = true) =>
    signInternalDevJwt(
      { sub: subject, email, name: null, email_verified: emailVerified },
      secret,
      3600,
    );

  const me = (token: string, tenantId: string) =>
    request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId);
  // The businesses a login is offered. An identity that can enter none is
  // refused outright (403) — the same as an empty list for these tests.
  const businesses = async (token: string): Promise<string[]> => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${token}`);
    if (res.status === 403) return [];
    expect(res.status).toBe(200);
    return (res.body as InternalBusinessesResponse).businesses.map((b) => b.id);
  };
  const reload = (id: string) =>
    prisma.internalUser.findUniqueOrThrow({ where: { id } });
  const subject = (key: string) => `internal-dev:sc1d-${key}-${suffix}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = secret;
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        LocationsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    try {
      await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
      await removeTestTenantB(prisma);
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  it('Mocha House: a verified login binds an unbound staff row whose email differs only by case — and the stored email is not rewritten', async () => {
    const stored = address('Case.Staff');
    const row = await staff(MOCHA, stored);
    const token = tokenFor(subject('case'), stored.toLowerCase());

    const res = await me(token, MOCHA).expect(200);
    expect((res.body as InternalMeResponse).user.id).toBe(row.id);
    const after = await reload(row.id);
    expect(after.externalSubject).toBe(subject('case'));
    expect(after.email).toBe(stored);

    // Bound now: later sign-ins match by subject, whatever the email says.
    await me(
      tokenFor(subject('case'), 'someone-else@example.com'),
      MOCHA,
    ).expect(200);
  });

  it('an upper-case login binds a lower-case row', async () => {
    const stored = address('lower').toLowerCase();
    const row = await staff(MOCHA, stored);
    await me(tokenFor(subject('upper'), stored.toUpperCase()), MOCHA).expect(
      200,
    );
    expect((await reload(row.id)).externalSubject).toBe(subject('upper'));
  });

  it('an unverified email never binds, in any letter case', async () => {
    const stored = address('unverified');
    const row = await staff(MOCHA, stored);
    for (const email of [stored, stored.toLowerCase(), stored.toUpperCase()]) {
      await me(tokenFor(subject('unverified'), email, false), MOCHA).expect(
        403,
      );
    }
    expect((await reload(row.id)).externalSubject).toBeNull();
    expect(
      await businesses(tokenFor(subject('unverified'), stored, false)),
    ).toEqual([]);
  });

  it('a row already bound to a login is never re-bound or reassigned by email', async () => {
    const stored = address('Bound');
    const row = await staff(MOCHA, stored, {
      subject: subject('owner-of-bound'),
    });
    // A different verified login with the same address (any case) gets nothing.
    await me(tokenFor(subject('intruder'), stored.toLowerCase()), MOCHA).expect(
      403,
    );
    const after = await reload(row.id);
    expect(after.externalSubject).toBe(subject('owner-of-bound'));
    // The rightful login is unaffected.
    await me(tokenFor(subject('owner-of-bound'), stored), MOCHA).expect(200);
  });

  it('case-only duplicate unbound rows in one business are ambiguous: nothing binds and the business is not offered', async () => {
    const first = await staff(MOCHA, address('dup').toLowerCase());
    const second = await staff(MOCHA, address('DUP').toUpperCase());
    const token = tokenFor(subject('dup'), address('Dup'));

    await me(token, MOCHA).expect(403);
    expect(await businesses(token)).not.toContain(MOCHA);
    expect((await reload(first.id)).externalSubject).toBeNull();
    expect((await reload(second.id)).externalSubject).toBeNull();
  });

  it('binding is scoped to the business being entered: no cross-tenant claim', async () => {
    const stored = address('Cross');
    const rowB = await staff(TENANT_B, stored);
    const token = tokenFor(subject('cross'), stored.toUpperCase());

    // Not a member of Mocha House: refused, and Tenant B's row is untouched.
    await me(token, MOCHA).expect(403);
    expect((await reload(rowB.id)).externalSubject).toBeNull();

    // Offered (and enterable) only where the row is.
    expect(await businesses(token)).toEqual([TENANT_B]);
    await me(token, TENANT_B).expect(200);
    expect((await reload(rowB.id)).externalSubject).toBe(subject('cross'));
  });

  it('one person with case-variant rows in two businesses binds each only when entering it', async () => {
    const rowA = await staff(MOCHA, address('Two').toLowerCase());
    const rowB = await staff(TENANT_B, address('TWO').toUpperCase());
    const token = tokenFor(subject('two'), address('Two'));

    expect((await businesses(token)).sort()).toEqual([MOCHA, TENANT_B].sort());
    await me(token, MOCHA).expect(200);
    expect((await reload(rowA.id)).externalSubject).toBe(subject('two'));
    expect((await reload(rowB.id)).externalSubject).toBeNull();
  });

  it('INVITED, SUSPENDED and DISABLED rows stay refused and unbound, in any case', async () => {
    for (const status of ['INVITED', 'SUSPENDED', 'DISABLED'] as const) {
      const stored = address(`Status-${status}`);
      const row = await staff(MOCHA, stored, { status });
      await me(tokenFor(subject(status), stored.toLowerCase()), MOCHA).expect(
        403,
      );
      const after = await reload(row.id);
      expect(after.externalSubject).toBeNull();
      expect(after.status).toBe(status);
      expect(await businesses(tokenFor(subject(status), stored))).toEqual([]);
    }
  });

  it('`_` and `%` are literal characters, never wildcards', async () => {
    const row = await staff(MOCHA, `under_score-${suffix}@example.com`);
    await me(
      tokenFor(subject('wild1'), `underXscore-${suffix}@example.com`),
      MOCHA,
    ).expect(403);
    await me(
      tokenFor(subject('wild2'), `under%-${suffix}@example.com`),
      MOCHA,
    ).expect(403);
    expect((await reload(row.id)).externalSubject).toBeNull();
    await me(
      tokenFor(subject('wild3'), `UNDER_SCORE-${suffix}@EXAMPLE.COM`),
      MOCHA,
    ).expect(200);
  });

  it('another identity provider never matches, whatever the case', async () => {
    const stored = address('Provider');
    const row = await staff(MOCHA, stored, { provider: 'cognito-internal' });
    await me(tokenFor(subject('provider'), stored.toLowerCase()), MOCHA).expect(
      403,
    );
    expect((await reload(row.id)).externalSubject).toBeNull();
  });

  it('surrounding whitespace in the token email does not prevent a match', async () => {
    const stored = address('Space');
    const row = await staff(MOCHA, stored);
    await me(
      tokenFor(subject('space'), `  ${stored.toLowerCase()} `),
      MOCHA,
    ).expect(200);
    expect((await reload(row.id)).externalSubject).toBe(subject('space'));
  });
});
