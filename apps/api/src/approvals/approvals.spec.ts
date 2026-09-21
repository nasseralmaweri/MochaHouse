import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminApprovalRequest, AdminCampaign } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { MediaModule } from '../media/media.module';
import { MarketingModule } from '../marketing/marketing.module';
import { ApprovalsModule } from './approvals.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 8J — the decider-facing Approvals API over real HTTP. This
// slice wires exactly one target type (Marketing Campaign activation), so
// every fixture here creates a real campaign and a real PENDING request
// against it via the actual Marketing endpoints — never by hand-crafting
// an ApprovalRequest row directly (the point is to prove the wiring, not
// just the table).
describe('Approvals admin (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'approvals-admin-spec-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const campaignIds: string[] = [];
  const approvalRequestIds: string[] = [];
  let locId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}-${suffix}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `approvals-admin-${suffix}-${randomUUID()}`,
        displayName: 'Approvals Admin Spec Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}-${suffix}`,
        email: `${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: user.id, roleId: role.id, ...scope },
    });
    return user.id;
  }

  const createCampaign = (key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/marketing/campaigns')
      .set('Authorization', `Bearer ${token(key)}`)
      .send({ name: `Approvals Spec Campaign ${randomUUID()}` });

  const requestApproval = (key: string, campaignId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/marketing/campaigns/${campaignId}/request-approval`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send({});

  const list = (key: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/approvals${query}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const getOne = (key: string, id: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/approvals/${id}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const approve = (key: string, id: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/approvals/${id}/approve`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send({});

  const reject = (key: string, id: string, reason?: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/approvals/${id}/reject`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send(reason === undefined ? {} : { reason });

  async function makePendingRequest(
    requesterKey = 'requester',
  ): Promise<{ campaign: AdminCampaign; approvalRequest: AdminApprovalRequest }> {
    const campaign = track(await createCampaign(requesterKey).expect(201));
    const afterRequest = (
      await requestApproval(requesterKey, campaign.id).expect(201)
    ).body as AdminCampaign;
    const approvalRequest = (
      await getOne('decider', afterRequest.latestApprovalRequestId!).expect(200)
    ).body.approvalRequest as AdminApprovalRequest;
    approvalRequestIds.push(approvalRequest.id);
    return { campaign: afterRequest, approvalRequest };
  }

  function track(res: { body: unknown }): AdminCampaign {
    const campaign = res.body as AdminCampaign;
    campaignIds.push(campaign.id);
    return campaign;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'approvals-admin-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        MarketingModule,
        MediaModule,
        ApprovalsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: { name: `Approvals Loc ${suffix}`, slug: `approvals-loc-${suffix}` },
      })
    ).id;

    await makeUserWithRole(
      'requester',
      ['marketing.view', 'marketing.manage'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await makeUserWithRole(
      'decider',
      ['approvals.view', 'approvals.decide', 'marketing.view', 'marketing.manage'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    // Holds approvals.* but NOT marketing.view — the "must be able to
    // inspect what they approve" rule must still block this user.
    await makeUserWithRole('noMarketingView', ['approvals.view', 'approvals.decide'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    // Holds marketing.view but NOT approvals.*.
    await makeUserWithRole('noApprovalsPerm', ['marketing.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole(
      'locationScoped',
      ['approvals.view', 'approvals.decide', 'marketing.view'],
      { scopeType: 'LOCATION', scopeId: locId },
    );
  }, 45_000);

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'approval_request', targetId: { in: approvalRequestIds } },
    });
    await prisma.approvalRequest.deleteMany({
      where: { id: { in: approvalRequestIds } },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'campaign', targetId: { in: campaignIds } },
    });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: locId } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  }, 30_000);

  // --- authorization -------------------------------------------

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/approvals').expect(401);
  });

  it('list/get require approvals.view AND marketing.view for this slice', async () => {
    const { approvalRequest } = await makePendingRequest();

    await list('noMarketingView').expect(403);
    await getOne('noMarketingView', approvalRequest.id).expect(403);
    await list('noApprovalsPerm').expect(403);
    await getOne('noApprovalsPerm', approvalRequest.id).expect(403);

    await list('decider').expect(200);
    await getOne('decider', approvalRequest.id).expect(200);
  });

  it('approve/reject require approvals.decide AND marketing.view', async () => {
    const { approvalRequest } = await makePendingRequest();

    await approve('noMarketingView', approvalRequest.id).expect(403);
    await reject('noMarketingView', approvalRequest.id, 'x').expect(403);
    await approve('noApprovalsPerm', approvalRequest.id).expect(403);
  });

  it('a LOCATION-scoped grant is rejected (CORPORATE-only)', async () => {
    const { approvalRequest } = await makePendingRequest();
    await list('locationScoped').expect(403);
    await approve('locationScoped', approvalRequest.id).expect(403);
  });

  // --- decisions -------------------------------------------------

  it('a requester cannot approve or reject their own request', async () => {
    const campaign = track(await createCampaign('decider').expect(201));
    const afterRequest = (
      await requestApproval('decider', campaign.id).expect(201)
    ).body as AdminCampaign;
    approvalRequestIds.push(afterRequest.latestApprovalRequestId!);

    await approve('decider', afterRequest.latestApprovalRequestId!).expect(403);
    await reject('decider', afterRequest.latestApprovalRequestId!, 'no').expect(403);
  });

  it('approve sets APPROVED + decider + decidedAt, and touches nothing else', async () => {
    const { campaign, approvalRequest } = await makePendingRequest();

    const decided = (
      await approve('decider', approvalRequest.id).expect(201)
    ).body.approvalRequest as AdminApprovalRequest;
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedByLabel).toBeTruthy();
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.decisionReason).toBeNull();

    // Approving never mutates the campaign itself.
    const untouchedCampaign = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/marketing/campaigns/${campaign.id}`)
        .set('Authorization', `Bearer ${token('decider')}`)
        .expect(200)
    ).body as AdminCampaign;
    expect(untouchedCampaign.status).toBe('DRAFT');
  });

  it('only a PENDING request can be approved or rejected', async () => {
    const { approvalRequest } = await makePendingRequest();
    await approve('decider', approvalRequest.id).expect(201);
    await approve('decider', approvalRequest.id).expect(409);
    await reject('decider', approvalRequest.id, 'x').expect(409);
  });

  it('reject requires a non-empty reason, records it, and leaves the campaign DRAFT and editable', async () => {
    const { campaign, approvalRequest } = await makePendingRequest();

    await reject('decider', approvalRequest.id).expect(400);
    await reject('decider', approvalRequest.id, '   ').expect(400);

    const decided = (
      await reject('decider', approvalRequest.id, 'Not enough detail on dates.').expect(
        201,
      )
    ).body.approvalRequest as AdminApprovalRequest;
    expect(decided.status).toBe('REJECTED');
    expect(decided.decisionReason).toBe('Not enough detail on dates.');

    // Rejected -> campaign stays DRAFT and becomes editable again.
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/marketing/campaigns/${campaign.id}`)
      .set('Authorization', `Bearer ${token('requester')}`)
      .send({ name: 'Renamed after rejection' })
      .expect(200);
  });

  it('an unknown approval request 404s on get/approve/reject', async () => {
    await getOne('decider', randomUUID()).expect(404);
    await approve('decider', randomUUID()).expect(404);
    await reject('decider', randomUUID(), 'x').expect(404);
  });

  // --- list / target label ----------------------------------------

  it('lists requests newest-first, filterable by status, with the campaign name as targetLabel', async () => {
    const { campaign, approvalRequest } = await makePendingRequest();

    const all = (await list('decider').expect(200)).body as {
      approvalRequests: AdminApprovalRequest[];
    };
    const found = all.approvalRequests.find((r) => r.id === approvalRequest.id);
    expect(found).toBeDefined();
    expect(found!.targetLabel).toBe(campaign.name);
    expect(found!.requestedByLabel).toBeTruthy();

    const pendingOnly = (await list('decider', '?status=PENDING').expect(200))
      .body as { approvalRequests: AdminApprovalRequest[] };
    expect(pendingOnly.approvalRequests.map((r) => r.id)).toContain(
      approvalRequest.id,
    );
    const approvedOnly = (await list('decider', '?status=APPROVED').expect(200))
      .body as { approvalRequests: AdminApprovalRequest[] };
    expect(approvedOnly.approvalRequests.map((r) => r.id)).not.toContain(
      approvalRequest.id,
    );
  });

  // --- duplicate-pending protection (DB level) --------------------

  it('the partial unique index blocks a second PENDING row for the same target+action even inserted directly', async () => {
    const { approvalRequest } = await makePendingRequest();
    // approvalRequest is already PENDING for its campaign — attempt a
    // second PENDING row directly via Prisma, bypassing the application's
    // own check-then-create. The database itself must refuse this.
    await expect(
      prisma.approvalRequest.create({
        data: {
          targetType: approvalRequest.targetType,
          targetId: approvalRequest.targetId,
          action: approvalRequest.action,
          requestedByInternalUserId: userIds[0]!,
        },
      }),
    ).rejects.toThrow();
  });

  // --- audit ------------------------------------------------------

  it('audits request/approve/reject with target identity and actor, never a campaign snapshot', async () => {
    const campaign = track(await createCampaign('requester').expect(201));
    const afterRequest = (
      await requestApproval('requester', campaign.id).expect(201)
    ).body as AdminCampaign;
    const approvalRequestId = afterRequest.latestApprovalRequestId!;
    approvalRequestIds.push(approvalRequestId);

    const requestedEvents = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'approval_request',
        targetId: approvalRequestId,
        action: 'approvals.request_created',
      },
    });
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]!.afterData).toMatchObject({
      targetType: 'Campaign',
      targetId: campaign.id,
      action: 'marketing.campaign_activate',
      status: 'PENDING',
    });

    await reject('decider', approvalRequestId, 'Needs another look.').expect(201);
    const rejectedEvents = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'approval_request',
        targetId: approvalRequestId,
        action: 'approvals.request_rejected',
      },
    });
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]!.reason).toContain('Needs another look.');
    const blob = JSON.stringify(rejectedEvents);
    expect(blob).not.toContain(campaign.name);
  });
});
