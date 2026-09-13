import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminMediaAssetsResponse,
  GetMediaAssetResponse,
  UpdateMediaAssetMetadataResponse,
  UploadMediaAssetResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { CmsModule } from '../cms/cms.module';
import { MediaModule } from './media.module';

// Milestone 8F — Media Library over real local Postgres, mirroring the
// established 8B–8E integration-spec pattern. Uses the default (local/
// in-memory) MediaStorage — no real AWS credentials required.
describe('Media Library (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  const originalEnv = { ...process.env };
  const internalSecret = 'media-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const mediaAssetIds: string[] = [];
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
        key: `media-spec-${suffix}-${randomUUID()}`,
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

  const auth = (key: string) => `Bearer ${token(key)}`;

  function uploadReq(key: string) {
    return request(app.getHttpServer())
      .post('/api/v1/admin/media')
      .set('Authorization', auth(key));
  }

  async function uploadValidImage(key = `manager-${suffix}`): Promise<
    UploadMediaAssetResponse['asset']
  > {
    const res = await uploadReq(key)
      .attach('file', Buffer.from('fake-jpeg-bytes'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    const body = res.body as UploadMediaAssetResponse;
    mediaAssetIds.push(body.asset.id);
    return body.asset;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    delete process.env.MEDIA_STORAGE_PROVIDER; // force local/in-memory

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CmsModule,
        MediaModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    audit = moduleFixture.get(InternalAuditService);

    activeLocationId = (
      await prisma.location.create({
        data: {
          name: `Media Active ${suffix}`,
          slug: `media-active-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    roles.viewer = await makeRole('Media Viewer', ['media.view']);
    // Also holds cms.view/cms.manage — the reference-conflict tests below
    // need this persona to save/publish the Home page too.
    roles.manager = await makeRole('Media Manager', [
      'media.view',
      'media.manage',
      'cms.view',
      'cms.manage',
    ]);
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

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.cmsPage.deleteMany({ where: { key: 'home' } });
    await prisma.mediaAsset.deleteMany({
      where: { OR: [{ id: { in: mediaAssetIds } }, { uploadedByInternalUserId: { in: userIds } }] },
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

  it('401 without a session; 403 without media.view; view can list; view cannot upload/deactivate; LOCATION grant rejected', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/media').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/admin/media')
      .set('Authorization', auth(`noPerm-${suffix}`))
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/admin/media')
      .set('Authorization', auth(`viewer-${suffix}`))
      .expect(200);

    await uploadReq(`viewer-${suffix}`)
      .attach('file', Buffer.from('x'), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${randomUUID()}/deactivate`)
      .set('Authorization', auth(`viewer-${suffix}`))
      .expect(403);

    // CORPORATE-only — a LOCATION-scoped manager is rejected
    await request(app.getHttpServer())
      .get('/api/v1/admin/media')
      .set('Authorization', auth(`locMgr-${suffix}`))
      .expect(403);
    await uploadReq(`locMgr-${suffix}`)
      .attach('file', Buffer.from('x'), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .expect(403);
  });

  // --- upload ---------------------------------------------

  it('accepts JPEG, PNG, and WebP; creates the asset; returns a resolved publicUrl', async () => {
    for (const [ext, contentType] of [
      ['jpg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const) {
      const asset = await (async () => {
        const res = await uploadReq(`manager-${suffix}`)
          .attach('file', Buffer.from('bytes'), {
            filename: `photo.${ext}`,
            contentType,
          })
          .expect(201);
        return (res.body as UploadMediaAssetResponse).asset;
      })();
      mediaAssetIds.push(asset.id);
      expect(asset.contentType).toBe(contentType);
      expect(asset.publicUrl).toEqual(expect.stringContaining('/api/v1/media/objects/media/'));
      // the storage object key is server-generated, never the uploaded
      // filename verbatim.
      expect(asset.publicUrl).not.toContain('photo.');
    }
  });

  it('rejects GIF, SVG, and non-image content types', async () => {
    await uploadReq(`manager-${suffix}`)
      .attach('file', Buffer.from('x'), { filename: 'a.gif', contentType: 'image/gif' })
      .expect(400);
    await uploadReq(`manager-${suffix}`)
      .attach('file', Buffer.from('x'), { filename: 'a.svg', contentType: 'image/svg+xml' })
      .expect(400);
    await uploadReq(`manager-${suffix}`)
      .attach('file', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(400);
  });

  it('rejects a file over 5 MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    await uploadReq(`manager-${suffix}`)
      .attach('file', oversized, { filename: 'big.jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('sanitizes the display filename and generates the storage key server-side', async () => {
    const res = await uploadReq(`manager-${suffix}`)
      .attach('file', Buffer.from('bytes'), {
        filename: '../../evil<script>.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    const asset = (res.body as UploadMediaAssetResponse).asset;
    mediaAssetIds.push(asset.id);
    expect(asset.fileName).not.toContain('<script>');
    expect(asset.fileName).not.toContain('/');
  });

  it('audits the upload with metadata only — never binary content', async () => {
    const before = await prisma.internalAuditEvent.count();
    const asset = await uploadValidImage();

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'media_asset', action: 'media.asset_uploaded' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(asset.id);
    expect(events[0]!.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    expect(events[0]!.afterData).toMatchObject({
      mediaAssetId: asset.id,
      contentType: 'image/jpeg',
    });
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('fake-jpeg-bytes');
    expect(await prisma.internalAuditEvent.count()).toBe(before + 1);
  });

  // --- list ------------------------------------------------

  it('lists active assets newest-first with cursor pagination; excludes deactivated', async () => {
    const a = await uploadValidImage();
    const b = await uploadValidImage();

    const list = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/media')
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    const ids = list.assets.map((asset) => asset.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id)); // newest first

    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${a.id}/deactivate`)
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(201);

    const after = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/media')
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    expect(after.assets.map((asset) => asset.id)).not.toContain(a.id);
    expect(after.assets.map((asset) => asset.id)).toContain(b.id);
  });

  it('search filters by fileName and by title, case-insensitively', async () => {
    const marker = `srch-${randomUUID().slice(0, 8)}`;
    const byFileName = await uploadReq(`manager-${suffix}`)
      .attach('file', Buffer.from('bytes'), {
        filename: `${marker}-photo.jpg`,
        contentType: 'image/jpeg',
      })
      .expect(201);
    const fileNameAsset = (byFileName.body as UploadMediaAssetResponse).asset;
    mediaAssetIds.push(fileNameAsset.id);

    const titledAsset = await uploadValidImage();
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/media/${titledAsset.id}`)
      .set('Authorization', auth(`manager-${suffix}`))
      .send({ title: `Title ${marker}` })
      .expect(200);

    const byFile = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/media?q=${marker.toUpperCase()}`)
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    expect(byFile.assets.map((a) => a.id)).toContain(fileNameAsset.id);
    expect(byFile.assets.map((a) => a.id)).toContain(titledAsset.id);

    const noMatch = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/media?q=${randomUUID()}`)
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    expect(noMatch.assets).toHaveLength(0);
  });

  it('paginates correctly across an explicit cursor walk', async () => {
    const a = await uploadValidImage();
    const b = await uploadValidImage();
    const c = await uploadValidImage();

    const page1 = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/media')
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    const idxC = page1.assets.findIndex((x) => x.id === c.id);
    expect(idxC).toBeGreaterThanOrEqual(0);

    // Walk forward from c's own cursor and confirm a/b appear afterward,
    // and c itself never reappears on a later page.
    const cursor = c.id;
    const page2 = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/media?cursor=${cursor}`)
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as AdminMediaAssetsResponse;
    expect(page2.assets.map((x) => x.id)).not.toContain(c.id);
    expect(page2.assets.map((x) => x.id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
  });

  // --- get one / metadata (Milestone 8I) ---------------------

  it('gets one asset by id; 404 for an unknown id; requires media.view', async () => {
    const asset = await uploadValidImage();

    const got = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/media/${asset.id}`)
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as GetMediaAssetResponse;
    expect(got.asset.id).toBe(asset.id);
    expect(got.asset.isActive).toBe(true);

    await request(app.getHttpServer())
      .get(`/api/v1/admin/media/${randomUUID()}`)
      .set('Authorization', auth(`viewer-${suffix}`))
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/v1/admin/media/${asset.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/media/${asset.id}`)
      .set('Authorization', auth(`noPerm-${suffix}`))
      .expect(403);
  });

  it('get-one still resolves an already-archived asset (for the detail screen)', async () => {
    const asset = await uploadValidImage();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${asset.id}/deactivate`)
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(201);

    const got = (
      await request(app.getHttpServer())
        .get(`/api/v1/admin/media/${asset.id}`)
        .set('Authorization', auth(`viewer-${suffix}`))
        .expect(200)
    ).body as GetMediaAssetResponse;
    expect(got.asset.isActive).toBe(false);
  });

  it('updates title and altText independently, requires media.manage, changes only those two fields', async () => {
    const asset = await uploadValidImage();
    expect(asset.title).toBeNull();
    expect(asset.altText).toBeNull();

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/media/${asset.id}`)
      .set('Authorization', auth(`viewer-${suffix}`))
      .send({ title: 'Nope' })
      .expect(403);

    const afterTitle = (
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/media/${asset.id}`)
        .set('Authorization', auth(`manager-${suffix}`))
        .send({ title: '  Hero background  ' })
        .expect(200)
    ).body as UpdateMediaAssetMetadataResponse;
    expect(afterTitle.asset.title).toBe('Hero background');
    expect(afterTitle.asset.altText).toBeNull();
    expect(afterTitle.asset.fileName).toBe(asset.fileName);
    expect(afterTitle.asset.contentType).toBe(asset.contentType);
    expect(afterTitle.asset.fileSizeBytes).toBe(asset.fileSizeBytes);
    expect(afterTitle.asset.publicUrl).toBe(asset.publicUrl);

    const afterAlt = (
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/media/${asset.id}`)
        .set('Authorization', auth(`manager-${suffix}`))
        .send({ altText: 'A steaming cup of coffee' })
        .expect(200)
    ).body as UpdateMediaAssetMetadataResponse;
    expect(afterAlt.asset.altText).toBe('A steaming cup of coffee');
    // title is untouched by an altText-only request.
    expect(afterAlt.asset.title).toBe('Hero background');

    // Blank clears the field to null.
    const cleared = (
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/media/${asset.id}`)
        .set('Authorization', auth(`manager-${suffix}`))
        .send({ title: '   ' })
        .expect(200)
    ).body as UpdateMediaAssetMetadataResponse;
    expect(cleared.asset.title).toBeNull();

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/media/${randomUUID()}`)
      .set('Authorization', auth(`manager-${suffix}`))
      .send({ title: 'x' })
      .expect(404);
  });

  it('audits a metadata update with before/after title+altText only, no PII/file content, and skips audit on a true no-op', async () => {
    const asset = await uploadValidImage();
    const before = await prisma.internalAuditEvent.count({
      where: { targetType: 'media_asset', action: 'media.asset_metadata_updated' },
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/media/${asset.id}`)
      .set('Authorization', auth(`manager-${suffix}`))
      .send({ title: 'Audited title', altText: 'Audited alt' })
      .expect(200);

    const events = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'media_asset',
        targetId: asset.id,
        action: 'media.asset_metadata_updated',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    expect(events[0]!.beforeData).toEqual({ title: null, altText: null });
    expect(events[0]!.afterData).toEqual({
      title: 'Audited title',
      altText: 'Audited alt',
    });
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetType: 'media_asset', action: 'media.asset_metadata_updated' },
      }),
    ).toBe(before + 1);

    // Re-sending the exact same values is a no-op — no new audit event.
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/media/${asset.id}`)
      .set('Authorization', auth(`manager-${suffix}`))
      .send({ title: 'Audited title', altText: 'Audited alt' })
      .expect(200);
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetType: 'media_asset', action: 'media.asset_metadata_updated' },
      }),
    ).toBe(before + 1);
  });

  // --- deactivate -------------------------------------------

  it('deactivates an unreferenced asset and audits it', async () => {
    const asset = await uploadValidImage();
    const before = await prisma.internalAuditEvent.count({
      where: { targetType: 'media_asset', action: 'media.asset_deactivated' },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${asset.id}/deactivate`)
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(201);

    const row = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row!.isActive).toBe(false);
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetType: 'media_asset', action: 'media.asset_deactivated' },
      }),
    ).toBe(before + 1);
  });

  it('refuses (409) to deactivate an asset referenced by Home draftContent, and again for publishedContent — asset stays active', async () => {
    const asset = await uploadValidImage();

    await request(app.getHttpServer())
      .patch('/api/v1/admin/content/home')
      .set('Authorization', auth(`manager-${suffix}`))
      .send({
        content: {
          hero: {
            headline: 'Welcome',
            supportingText: 'Great coffee.',
            buttonLabel: 'Order Online',
            backgroundImageId: asset.id,
          },
          featuredProducts: { heading: 'Favorites', productIds: [] },
          seo: {},
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${asset.id}/deactivate`)
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(409);
    let row = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row!.isActive).toBe(true);

    // publish it — still referenced (now via publishedContent) — still 409
    await request(app.getHttpServer())
      .post('/api/v1/admin/content/home/publish')
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/media/${asset.id}/deactivate`)
      .set('Authorization', auth(`manager-${suffix}`))
      .expect(409);
    row = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row!.isActive).toBe(true);
  });
});
