import 'dotenv/config';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  EmailSender,
  SendEmailInput,
  SendEmailResult,
} from '../notifications/email/email-sender';
import { EmailProviderRejection } from '../notifications/delivery-errors';
import {
  BillingLoggingEmailSender,
  BillingSesEmailSender,
  selectBillingEmailSender,
} from './billing-email-sender';
import { BillingNotificationProcessor } from './billing-notification-processor.service';
import { BillingNotificationStore } from './billing-notification-store';
import { renderBillingNotice } from './billing-templates';

// SC3c-3 — the CENTERIVO billing notice worker, on a scratch database:
// leased delivery to the recipient chosen AT DELIVERY TIME (recently
// verified contact, else the earliest eligible administrator, else nobody
// and a review case), at most two attempts, a failure handed to review, a
// stale or no-longer-true notice skipped, and the separate billing sender.

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../packages/database/prisma/migrations'),
);
const A = '01a0db02-f800-7000-8000-5b0000003c3a';
const B = '01a0db02-f800-7000-8000-5b0000003c3b';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

class ScriptedSender implements EmailSender {
  readonly sent: SendEmailInput[] = [];
  readonly script: (Error | null)[] = [];
  send(input: SendEmailInput): Promise<SendEmailResult> {
    const next = this.script.shift() ?? null;
    if (next) return Promise.reject(next);
    this.sent.push(input);
    return Promise.resolve({ providerMessageId: `m-${this.sent.length}` });
  }
}

describe('SC3c-3 billing notification worker', () => {
  let scratch: ScratchDatabase;
  let db: PrismaClient;
  let sender: ScriptedSender;
  let processor: BillingNotificationProcessor;
  let store: BillingNotificationStore;
  const original = process.env.BILLING_NOTIFICATIONS_ENABLED;
  let subA: string;
  let subB: string;
  let n = 0;

  const sql = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) => c.query(text, params));

  async function queue(
    subscriptionId: string,
    kind: string,
    payload: object = { deadline: null, enforced: true },
    expiresInSeconds = 86_400,
  ): Promise<string> {
    n += 1;
    const { rows } = await sql(
      `INSERT INTO "BillingNotification" (id, "subscriptionId", kind, "dedupeKey", payload, "expiresAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, timezone('utc', now()) + ($5 || ' seconds')::interval)
       RETURNING id`,
      [
        subscriptionId,
        kind,
        `test-${n}`,
        JSON.stringify(payload),
        String(expiresInSeconds),
      ],
    );
    return (rows[0] as { id: string }).id;
  }
  const row = async (id: string) =>
    (
      await sql(
        `SELECT status, "attemptCount", "possibleDuplicate", "lastErrorCode", "sentAt" IS NOT NULL AS sent
           FROM "BillingNotification" WHERE id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;
  const openCases = async (subscriptionId: string) =>
    (
      await sql(
        `SELECT kind FROM "BillingReconciliationCase" WHERE "subscriptionId" = $1 AND status = 'OPEN' ORDER BY kind`,
        [subscriptionId],
      )
    ).rows.map((r) => (r as { kind: string }).kind);
  // The next retry is due now (instead of in 15 minutes).
  const dueNow = (id: string) =>
    sql(
      `UPDATE "BillingNotification" SET "nextAttemptAt" = timezone('utc', now()) WHERE id = $1`,
      [id],
    );

  beforeAll(async () => {
    process.env.BILLING_NOTIFICATIONS_ENABLED = '1';
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c3_worker',
    );
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    const prisma = db as unknown as PrismaService;
    sender = new ScriptedSender();
    store = new BillingNotificationStore(prisma);
    processor = new BillingNotificationProcessor(prisma, store, sender);

    for (const [id, slug, name] of [
      [A, 'sc3c3-w-a', 'Alpha <Cafe>'],
      [B, 'sc3c3-w-b', 'Beta Cafe'],
    ]) {
      await sql(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [id, slug, name],
      );
      await sql(
        `INSERT INTO "InternalRole" (id, key, "displayName", "updatedAt", "tenantId") VALUES ($1, 'platform-administrator', 'Admin', now(), $2)`,
        [`role-${slug}`, id],
      );
      await sql(
        `INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId") VALUES ($1, 'billing.manage', $2)`,
        [`role-${slug}`, id],
      );
    }
    const user = async (
      id: string,
      tenantId: string,
      email: string,
      verifiedDaysAgo: number | null,
      role: string,
    ) => {
      await sql(
        `INSERT INTO "InternalUser" (id, "externalProvider", email, status, "verifiedEmail", "emailVerifiedAt", "updatedAt", "tenantId", "createdAt")
         VALUES ($1, 'internal-dev', $2, 'ACTIVE', $3, $4, now(), $5, now() - interval '1 second' * $6)`,
        [
          id,
          email,
          verifiedDaysAgo === null ? null : email,
          verifiedDaysAgo === null
            ? null
            : new Date(Date.now() - verifiedDaysAgo * 86_400_000),
          tenantId,
          id.length,
        ],
      );
      await sql(
        `INSERT INTO "InternalUserRoleAssignment" (id, "internalUserId", "roleId", "scopeType", "updatedAt", "tenantId")
         VALUES (gen_random_uuid()::text, $1, $2, 'CORPORATE', now(), $3)`,
        [id, role, tenantId],
      );
    };
    // A: an owner with a verified email, and a designated contact verified
    // 200 days ago (stale) -> the owner receives billing email.
    await user('owner-a', A, 'owner-a@example.test', 1, 'role-sc3c3-w-a');
    await user('contact-a', A, 'contact-a@example.test', 200, 'role-sc3c3-w-a');
    await sql(
      `INSERT INTO "TenantBillingContact" (id, "tenantId", "internalUserId", "updatedAt") VALUES ('bc-a', $1, 'contact-a', now())`,
      [A],
    );
    // B: nobody verified.
    await user('owner-b', B, 'owner-b@example.test', null, 'role-sc3c3-w-b');

    const price = (
      (
        await sql(
          `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
           VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
          [FOUNDING_PLAN],
        )
      ).rows[0] as { id: string }
    ).id;
    const subscription = async (tenantId: string, status: string) =>
      (
        (
          await sql(
            `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "billingMode", "billingProvider", "externalCustomerId", "planPriceId", status, "pastDueAt", "graceEndsAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, 'BILLED', 'fake', $4, $5, $3, now() - interval '2 days', now() + interval '12 days', now()) RETURNING id`,
            [tenantId, FOUNDING_VERSION, status, `cus_${tenantId}`, price],
          )
        ).rows[0] as { id: string }
      ).id;
    subA = await subscription(A, 'PAST_DUE');
    subB = await subscription(B, 'PAST_DUE');
  });

  afterEach(() => {
    sender.sent.length = 0;
    sender.script.length = 0;
  });

  afterAll(async () => {
    process.env.BILLING_NOTIFICATIONS_ENABLED = original;
    await db?.$disconnect();
    await scratch?.drop();
  });

  it('sends to the recipient chosen at delivery time, from CENTERIVO, without a payment link', async () => {
    const id = await queue(subA, 'PAYMENT_FAILED', {
      deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      enforced: true,
    });
    expect(await processor.drain()).toEqual(['SENT']);
    expect(sender.sent).toHaveLength(1);
    const [mail] = sender.sent;
    expect(mail.to).toBe('owner-a@example.test');
    expect(mail.fromName).toBe('CENTERIVO');
    expect(mail.subject).toBe('Payment failed for Alpha <Cafe>');
    expect(mail.html).toContain('Alpha &lt;Cafe&gt;');
    expect(`${mail.text}${mail.html}`).not.toMatch(/https?:\/\//);
    expect(await row(id)).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      sent: true,
    });
    // Not silent: the designated contact's verification expired, so a case
    // is opened even though the fallback administrator received it.
    expect(await openCases(subA)).toEqual(['BILLING_CONTACT_UNVERIFIED']);
    // Finished: never claimed again.
    expect(await processor.drain()).toEqual([]);
  });

  it('nobody eligible: nothing is sent, the notice is skipped and a BILLING_CONTACT_MISSING case is opened (once)', async () => {
    const first = await queue(subB, 'PAYMENT_FAILED');
    const second = await queue(subB, 'PAYMENT_FAILED');
    expect(await processor.drain()).toEqual(['SKIPPED', 'SKIPPED']);
    expect(sender.sent).toEqual([]);
    expect(await row(first)).toMatchObject({
      status: 'SKIPPED',
      lastErrorCode: 'NO_ELIGIBLE_RECIPIENT',
    });
    expect(await row(second)).toMatchObject({ status: 'SKIPPED' });
    expect(await openCases(subB)).toEqual(['BILLING_CONTACT_MISSING']);
  });

  it('a notice that is stale or no longer true is skipped without sending', async () => {
    const expired = await queue(
      subA,
      'PAYMENT_FAILED',
      { deadline: null, enforced: true },
      -1,
    );
    const notTrue = await queue(subA, 'BILLING_SUSPENDED');
    const unknownCase = await queue(subA, 'RESTART_UNDER_REVIEW', {
      deadline: null,
      enforced: true,
      caseId: 'nope',
    });
    expect(await processor.drain()).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
    expect(sender.sent).toEqual([]);
    expect(await row(expired)).toMatchObject({ lastErrorCode: 'EXPIRED' });
    expect(await row(notTrue)).toMatchObject({
      lastErrorCode: 'NO_LONGER_RELEVANT',
    });
    expect(await row(unknownCase)).toMatchObject({
      lastErrorCode: 'NO_LONGER_RELEVANT',
    });
  });

  it('at most two attempts: a retryable refusal is retried once, then FAILED with a review case', async () => {
    const id = await queue(subA, 'PAYMENT_FAILED');
    sender.script.push(
      new EmailProviderRejection('Throttling', 'slow down', true),
    );
    expect(await processor.drain()).toEqual(['RETRY']);
    expect(await row(id)).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      lastErrorCode: 'THROTTLING',
    });
    // Not due yet.
    expect(await processor.drain()).toEqual([]);
    await dueNow(id);
    sender.script.push(
      new EmailProviderRejection('Throttling', 'slow down', true),
    );
    expect(await processor.drain()).toEqual(['FAILED']);
    expect(await row(id)).toMatchObject({ status: 'FAILED', attemptCount: 2 });
    expect(await openCases(subA)).toContain('BILLING_NOTIFICATION_FAILED');
    // Final: never claimed again (and the database refuses to reopen it).
    expect(await processor.drain()).toEqual([]);
    await expect(dueNow(id)).rejects.toThrow();
    expect(sender.sent).toEqual([]);
  });

  it('a definite, non-retryable refusal fails at once; an unknown outcome is retried once and flagged as a possible duplicate', async () => {
    const rejected = await queue(subA, 'PAYMENT_FAILED');
    sender.script.push(
      new EmailProviderRejection('MessageRejected', 'no', false),
    );
    expect(await processor.drain()).toEqual(['FAILED']);
    expect(await row(rejected)).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      possibleDuplicate: false,
    });

    const unknown = await queue(subA, 'PAYMENT_FAILED');
    sender.script.push(new Error('socket hang up'));
    expect(await processor.drain()).toEqual(['RETRY']);
    await dueNow(unknown);
    expect(await processor.drain()).toEqual(['SENT']);
    expect(await row(unknown)).toMatchObject({
      status: 'SENT',
      attemptCount: 2,
      possibleDuplicate: true,
    });
  });

  it('an attempt abandoned mid-send (lease expired after the last attempt) is closed as FAILED, a possible duplicate, with a review case', async () => {
    const id = await queue(subA, 'PAYMENT_FAILED');
    await sql(
      `UPDATE "BillingNotification" SET "attemptCount" = 2, "sendStartedAt" = timezone('utc', now()),
              "leaseOwner" = 'dead', "leaseExpiresAt" = timezone('utc', now()) - interval '1 minute'
        WHERE id = $1`,
      [id],
    );
    await sql(
      `UPDATE "BillingReconciliationCase" SET status = 'RESOLVED', "resolvedAt" = now() WHERE "subscriptionId" = $1`,
      [subA],
    );
    expect(await processor.drain()).toEqual([]);
    expect(await row(id)).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'ATTEMPT_ABANDONED',
      possibleDuplicate: true,
    });
    expect(await openCases(subA)).toEqual(['BILLING_NOTIFICATION_FAILED']);
  });

  it('a stale lease holder changes nothing (fencing)', async () => {
    const id = await queue(subA, 'PAYMENT_FAILED');
    const claim = (await store.claim(60_000))!;
    expect(claim.id).toBe(id);
    // The lease expires and another worker re-claims it.
    await sql(
      `UPDATE "BillingNotification" SET "leaseExpiresAt" = timezone('utc', now()) - interval '1 second' WHERE id = $1`,
      [id],
    );
    const again = (await store.claim(60_000))!;
    expect(again.id).toBe(id);
    expect(await store.finish(claim, 'SENT', null)).toBe(false);
    expect(await store.finish(again, 'SKIPPED', 'TEST')).toBe(true);
  });

  it('a claim whose lease lapsed before sending never sends', async () => {
    const id = await queue(subA, 'PAYMENT_FAILED');
    const claim = (await store.claim(60_000))!;
    await sql(
      `UPDATE "BillingNotification" SET "leaseExpiresAt" = timezone('utc', now()) - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await processor.deliver(claim)).toBe('LOST_CLAIM');
    expect(sender.sent).toEqual([]);
    expect(await row(id)).toMatchObject({ status: 'PENDING' });
    // Re-claimed and delivered normally.
    expect(await processor.drain()).toEqual(['SENT']);
  });

  it('does nothing while billing notifications are off', async () => {
    process.env.BILLING_NOTIFICATIONS_ENABLED = '0';
    try {
      const id = await queue(subA, 'PAYMENT_FAILED');
      expect(await processor.drain()).toEqual([]);
      expect(await row(id)).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
      });
    } finally {
      process.env.BILLING_NOTIFICATIONS_ENABLED = '1';
    }
  });
});

describe('SC3c-3 billing sender and templates', () => {
  it('uses its own from-address and provider switch, separate from restaurant notifications', async () => {
    const log = new BillingLoggingEmailSender();
    const ses = new BillingSesEmailSender();
    expect(
      selectBillingEmailSender(log, ses, {
        NOTIFICATIONS_EMAIL_PROVIDER: 'ses',
      }),
    ).toBe(log);
    expect(
      selectBillingEmailSender(log, ses, { BILLING_EMAIL_PROVIDER: 'ses' }),
    ).toBe(ses);
    const saved = { ...process.env };
    try {
      process.env.NOTIFICATIONS_SES_FROM_EMAIL = 'orders@restaurant.example';
      delete process.env.BILLING_EMAIL_FROM;
      const refusal = await ses
        .send({ to: 'x@example.test', subject: 's', html: 'h', text: 't' })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(EmailProviderRejection);
      expect((refusal as EmailProviderRejection).code).toBe(
        'SES_NOT_CONFIGURED',
      );
      expect((refusal as EmailProviderRejection).message).toContain(
        'BILLING_EMAIL_FROM',
      );
    } finally {
      process.env = saved;
    }
  });

  it('never threatens a suspension enforcement would not apply, and states temporary access plainly', () => {
    const off = renderBillingNotice('PAYMENT_FAILED', 'Cafe', {
      deadline: '2026-11-01T00:00:00Z',
      enforced: false,
    });
    expect(off.text).not.toMatch(/limited/);
    const on = renderBillingNotice('PAYMENT_FAILED', 'Cafe', {
      deadline: '2026-11-01T00:00:00Z',
      enforced: true,
    });
    expect(on.text).toMatch(/limited to billing/);
    const temporary = renderBillingNotice('ACCESS_RESTORED', 'Cafe', {
      deadline: '2026-11-01T00:00:00Z',
      enforced: true,
      temporary: true,
    });
    expect(temporary.subject).toMatch(/temporary/);
    expect(temporary.text).toMatch(/still unpaid/);
    // Header-safe subject.
    expect(
      renderBillingNotice('RESTART_CONFIRMED', 'Evil\r\nBcc: x@y', {
        deadline: null,
        enforced: true,
      }).subject,
    ).not.toMatch(/[\r\n]/);
  });
});
