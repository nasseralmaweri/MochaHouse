import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminCmsPageDetail,
  AdminCmsPagesResponse,
  FranchisingPageContent,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { CmsModule } from './cms.module';

// Milestone 8E — CMS foundation over real local Postgres, mirroring
// franchising-inquiries.spec.ts (8D).
describe('CMS / Content pages (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  const originalEnv = { ...process.env };
  const internalSecret = 'cms-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};
  let activeLocationId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string): Promise<void> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    users[key] = user.id;
  }

  async function makeRole(name: string, keys: string[]): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `cms-spec-${suffix}-${randomUUID()}`,
        displayName: name,
        permissions: {
          create: keys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(
    key: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ): Promise<void> {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: users[key]!, roleId, ...scope },
    });
  }

  const adminReq = (
    method: 'get' | 'post' | 'patch',
    path: string,
    key: string,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin/content${path}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const publicRead = (pageKey: string) =>
    request(app.getHttpServer()).get(`/api/v1/content/${pageKey}`);

  function validContent(
    overrides: Partial<FranchisingPageContent> = {},
  ): FranchisingPageContent {
    return {
      intro: { heading: `Intro ${suffix}`, body: 'Intro body.' },
      opportunity: { heading: 'Opportunity', body: 'Opportunity body.' },
      process: {
        heading: 'How it works',
        steps: [
          { title: 'Step one', body: 'Body one.' },
          { title: 'Step two', body: 'Body two.' },
        ],
      },
      cta: {
        heading: 'Interested?',
        body: 'Get started.',
        buttonLabel: 'Submit an inquiry',
      },
      seo: { pageTitle: null, metaDescription: null },
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CmsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    audit = moduleFixture.get(InternalAuditService);

    activeLocationId = (
      await prisma.location.create({
        data: {
          name: `CMS Active ${suffix}`,
          slug: `cms-active-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    roles.viewer = await makeRole('CMS Viewer', ['cms.view']);
    roles.manager = await makeRole('CMS Manager', ['cms.view', 'cms.manage']);
    roles.none = await makeRole('Orders Only', ['orders.view']);

    await makeUser(`viewer-${suffix}`);
    await assign(`viewer-${suffix}`, roles.viewer, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`manager-${suffix}`);
    await assign(`manager-${suffix}`, roles.manager, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`noPerm-${suffix}`);
    await assign(`noPerm-${suffix}`, roles.none, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`locMgr-${suffix}`);
    await assign(`locMgr-${suffix}`, roles.manager, {
      scopeType: 'LOCATION',
      scopeId: activeLocationId,
    });
  });

  afterEach(async () => {
    // Every test starts from "no row" — the registry/lazy-default
    // behaviour depends on it.
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'cms_page' },
    });
    await prisma.cmsPage.deleteMany({ where: { key: 'franchising' } });
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: activeLocationId } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // --- authorization ------------------------------------------

  it('401 without a session; 403 without cms.view; view can read; view cannot manage; LOCATION grant rejected', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/content').expect(401);

    await adminReq('get', '', `noPerm-${suffix}`).expect(403);
    await adminReq('get', '/franchising', `noPerm-${suffix}`).expect(403);

    await adminReq('get', '', `viewer-${suffix}`).expect(200);
    await adminReq('get', '/franchising', `viewer-${suffix}`).expect(200);

    await adminReq('patch', '/franchising', `viewer-${suffix}`)
      .send({ content: validContent() })
      .expect(403);
    await adminReq('post', '/franchising/publish', `viewer-${suffix}`).expect(403);

    // CORPORATE-only — a LOCATION-scoped manager is rejected
    await adminReq('get', '', `locMgr-${suffix}`).expect(403);
    await adminReq('patch', '/franchising', `locMgr-${suffix}`)
      .send({ content: validContent() })
      .expect(403);
  });

  // --- registry / read ------------------------------------

  it('lists exactly the approved registry keys; unknown key -> 404; GET never creates a row', async () => {
    const list = (
      await adminReq('get', '', `viewer-${suffix}`).expect(200)
    ).body as AdminCmsPagesResponse;
    // Registry order — franchising (8E) then home (8F).
    expect(list.pages.map((p) => p.key)).toEqual(['franchising', 'home']);
    expect(list.pages[0]).toMatchObject({
      status: 'DRAFT',
      publishedAt: null,
      hasUnpublishedChanges: true,
    });

    await adminReq('get', '/unknown-page', `viewer-${suffix}`).expect(404);

    const detail = (
      await adminReq('get', '/franchising', `viewer-${suffix}`).expect(200)
    ).body as AdminCmsPageDetail;
    expect(detail.status).toBe('DRAFT');
    expect(detail.publishedContent).toBeNull();
    expect(detail.hasUnpublishedChanges).toBe(true);
    expect(detail.draftContent.intro.heading).toEqual(expect.any(String));

    // Neither GET wrote a row.
    expect(await prisma.cmsPage.findUnique({ where: { key: 'franchising' } })).toBeNull();
  });

  // --- save draft ------------------------------------------

  it('PATCH creates the row, validates the shape, trims values, and leaves publishedContent untouched', async () => {
    expect(await prisma.cmsPage.findUnique({ where: { key: 'franchising' } })).toBeNull();

    const content = validContent({
      intro: { heading: '  Trimmed Heading  ', body: '  Trimmed body.  ' },
    });
    const detail = (
      await adminReq('patch', '/franchising', `manager-${suffix}`)
        .send({ content })
        .expect(200)
    ).body as AdminCmsPageDetail;

    expect(detail.status).toBe('DRAFT');
    expect(detail.draftContent.intro.heading).toBe('Trimmed Heading');
    expect(detail.draftContent.intro.body).toBe('Trimmed body.');
    expect(detail.publishedContent).toBeNull();
    expect(detail.hasUnpublishedChanges).toBe(true);

    const row = await prisma.cmsPage.findUnique({ where: { key: 'franchising' } });
    expect(row).not.toBeNull();
    expect(row!.publishedContent).toBeNull();
  });

  it('rejects an invalid/unknown structure and enforces process-step bounds (1..6)', async () => {
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: { intro: { heading: '', body: 'x' } } })
      .expect(400);
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({
        content: validContent({
          process: { heading: 'How', steps: [] },
        }),
      })
      .expect(400);
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({
        content: validContent({
          process: {
            heading: 'How',
            steps: Array.from({ length: 7 }, (_, i) => ({
              title: `Step ${i}`,
              body: 'Body',
            })),
          },
        }),
      })
      .expect(400);
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({
        content: validContent({
          process: {
            heading: 'How',
            steps: [{ title: '', body: 'Body' }],
          },
        }),
      })
      .expect(400);
    // no row was created by any of the rejected attempts
    expect(await prisma.cmsPage.findUnique({ where: { key: 'franchising' } })).toBeNull();
  });

  it('a draft edit after publish leaves the page PUBLISHED and marks hasUnpublishedChanges', async () => {
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent() })
      .expect(200);
    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201);

    const edited = (
      await adminReq('patch', '/franchising', `manager-${suffix}`)
        .send({ content: validContent({ intro: { heading: 'Edited', body: 'Body.' } }) })
        .expect(200)
    ).body as AdminCmsPageDetail;

    expect(edited.status).toBe('PUBLISHED');
    expect(edited.hasUnpublishedChanges).toBe(true);
    expect(edited.draftContent.intro.heading).toBe('Edited');
    expect(edited.publishedContent!.intro.heading).not.toBe('Edited');
  });

  it('audits the draft save atomically with only changed field keys, never content values', async () => {
    const before = await prisma.internalAuditEvent.count();
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent() })
      .expect(200);

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'cms_page', action: 'cms.content_updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    expect(events[0]!.afterData).toMatchObject({ pageKey: 'franchising' });
    const payload = events[0]!.afterData as { changedFieldKeys: string[] };
    expect(payload.changedFieldKeys).toEqual(
      expect.arrayContaining(['intro', 'opportunity', 'process', 'cta']),
    );
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('Intro body');
    expect(blob).not.toContain('Opportunity body');

    // atomicity — audit write fails, no row created
    const spy = jest
      .spyOn(audit, 'recordCmsContentUpdated')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent({ intro: { heading: 'Should not persist', body: 'x' } }) })
      .expect(500);
    spy.mockRestore();
    const row = await prisma.cmsPage.findUnique({ where: { key: 'franchising' } });
    expect(row!.draftContent).toMatchObject(validContent());
    expect(await prisma.internalAuditEvent.count()).toBe(before + 1);
  });

  // --- publish ---------------------------------------------

  it('first publish copies draft -> published, sets status and publishedAt, clears hasUnpublishedChanges', async () => {
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent() })
      .expect(200);

    const published = (
      await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201)
    ).body as AdminCmsPageDetail;

    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).not.toBeNull();
    expect(published.hasUnpublishedChanges).toBe(false);
    expect(published.publishedContent).toEqual(published.draftContent);
  });

  it('publish with no prior draft save still works (uses the registry default)', async () => {
    const published = (
      await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201)
    ).body as AdminCmsPageDetail;
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedContent).not.toBeNull();
  });

  it('a second publish replaces the previous snapshot; the public API reflects it', async () => {
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent({ intro: { heading: 'First', body: 'Body.' } }) })
      .expect(200);
    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201);

    let publicBody = (await publicRead('franchising').expect(200))
      .body as { content: FranchisingPageContent };
    expect(publicBody.content.intro.heading).toBe('First');

    // edit + re-publish
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent({ intro: { heading: 'Second', body: 'Body.' } }) })
      .expect(200);
    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201);

    publicBody = (await publicRead('franchising').expect(200)).body as {
      content: FranchisingPageContent;
    };
    expect(publicBody.content.intro.heading).toBe('Second');
  });

  it('audits the publish atomically with only status + publishedAt, never content', async () => {
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent() })
      .expect(200);
    const before = await prisma.internalAuditEvent.count();

    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201);
    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'cms_page', action: 'cms.content_published' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.afterData).toMatchObject({
      pageKey: 'franchising',
      status: 'PUBLISHED',
    });
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('Intro body');
    expect(await prisma.internalAuditEvent.count()).toBe(before + 1);

    // atomicity — audit write fails, status/publishedContent not persisted
    await prisma.cmsPage.update({
      where: { key: 'franchising' },
      data: { status: 'DRAFT', publishedContent: undefined as never, publishedAt: null },
    });
    const spy = jest
      .spyOn(audit, 'recordCmsContentPublished')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(500);
    spy.mockRestore();
    const row = await prisma.cmsPage.findUnique({ where: { key: 'franchising' } });
    expect(row!.status).toBe('DRAFT');
  });

  // --- public ------------------------------------------------

  it('public read: 404 with no row, 404 draft-only, 200 once published; unknown key 404; never exposes draft', async () => {
    await publicRead('franchising').expect(404);

    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent({ intro: { heading: 'Draft Only', body: 'x' } }) })
      .expect(200);
    await publicRead('franchising').expect(404); // still draft-only

    await adminReq('post', '/franchising/publish', `manager-${suffix}`).expect(201);
    const body = (await publicRead('franchising').expect(200)).body as {
      content: FranchisingPageContent;
    };
    expect(body.content.intro.heading).toBe('Draft Only');
    expect(JSON.stringify(body)).not.toContain('draftContent');

    // a later draft edit does not leak publicly until published again
    await adminReq('patch', '/franchising', `manager-${suffix}`)
      .send({ content: validContent({ intro: { heading: 'Unpublished Edit', body: 'x' } }) })
      .expect(200);
    const stillOld = (await publicRead('franchising').expect(200)).body as {
      content: FranchisingPageContent;
    };
    expect(stillOld.content.intro.heading).toBe('Draft Only');

    await publicRead('unknown-page').expect(404);
  });
});
