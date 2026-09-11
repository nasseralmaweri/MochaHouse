import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminCmsPageDetail,
  HomePageContent,
  PublicHomePageContentResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { MediaModule } from '../media/media.module';
import { CmsModule } from './cms.module';

// Milestone 8F — Home CMS (registry extension, reference validation,
// publish lifecycle) and the public Home content resolution, over real
// local Postgres.
describe('CMS / Home page (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  const originalEnv = { ...process.env };
  const internalSecret = 'home-cms-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  const mediaAssetIds: string[] = [];
  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );
  const auth = (key: string) => `Bearer ${token(key)}`;

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
        key: `home-cms-spec-${suffix}-${randomUUID()}`,
        displayName: name,
        permissions: { create: keys.map((permissionKey) => ({ permissionKey })) },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(key: string, roleId: string): Promise<void> {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: users[key]!, roleId, scopeType: 'CORPORATE', scopeId: null },
    });
  }

  const adminReq = (method: 'get' | 'post' | 'patch', path: string, key: string) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin/content${path}`)
      .set('Authorization', auth(key));

  const publicRead = () =>
    request(app.getHttpServer()).get('/api/v1/content/home');

  async function makeProduct(overrides: { isActive?: boolean } = {}): Promise<string> {
    const category = await prisma.category.create({
      data: { name: `Cat ${suffix} ${randomUUID().slice(0, 8)}`, slug: `cat-${suffix}-${randomUUID()}` },
    });
    categoryIds.push(category.id);
    const product = await prisma.product.create({
      data: {
        name: `Product ${randomUUID().slice(0, 8)}`,
        slug: `product-${suffix}-${randomUUID()}`,
        basePrice: 500,
        currency: 'USD',
        categoryId: category.id,
        isActive: overrides.isActive ?? true,
      },
    });
    productIds.push(product.id);
    return product.id;
  }

  async function makeMediaAsset(overrides: { isActive?: boolean } = {}): Promise<string> {
    const asset = await prisma.mediaAsset.create({
      data: {
        objectKey: `media/${randomUUID()}.jpg`,
        fileName: 'photo.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 1024,
        isActive: overrides.isActive ?? true,
        uploadedByInternalUserId: users[`manager-${suffix}`]!,
      },
    });
    mediaAssetIds.push(asset.id);
    return asset.id;
  }

  function validHomeContent(
    overrides: Partial<HomePageContent> = {},
  ): HomePageContent {
    return {
      hero: {
        headline: `Welcome ${suffix}`,
        supportingText: 'Great coffee, every day.',
        buttonLabel: 'Order Online',
        backgroundImageId: null,
      },
      featuredProducts: { heading: 'Fan Favorites', productIds: [] },
      seo: { pageTitle: null, metaDescription: null },
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    delete process.env.MEDIA_STORAGE_PROVIDER;

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

    roles.viewer = await makeRole('Home CMS Viewer', ['cms.view']);
    roles.manager = await makeRole('Home CMS Manager', ['cms.view', 'cms.manage']);

    await makeUser(`viewer-${suffix}`);
    await assign(`viewer-${suffix}`, roles.viewer);
    await makeUser(`manager-${suffix}`);
    await assign(`manager-${suffix}`, roles.manager);
  });

  afterEach(async () => {
    await prisma.internalAuditEvent.deleteMany({ where: { targetType: 'cms_page' } });
    await prisma.cmsPage.deleteMany({ where: { key: 'home' } });
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaAssetIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // --- structural validation --------------------------------

  it('requires hero headline/supportingText/buttonLabel and rejects unknown/invalid shapes', async () => {
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { headline: '', supportingText: 'x', buttonLabel: 'x', backgroundImageId: null } }) })
      .expect(400);
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: { hero: {} } })
      .expect(400);
  });

  it('rejects more than 8 featured products and duplicate product ids', async () => {
    const ids = await Promise.all(Array.from({ length: 9 }, () => makeProduct()));
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({
        content: validHomeContent({ featuredProducts: { heading: 'x', productIds: ids } }),
      })
      .expect(400);

    const [a, b] = await Promise.all([makeProduct(), makeProduct()]);
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({
        content: validHomeContent({ featuredProducts: { heading: 'x', productIds: [a, a, b] } }),
      })
      .expect(400);
  });

  // --- reference validation ---------------------------------

  it('rejects an unknown/inactive backgroundImageId on save and on publish', async () => {
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, backgroundImageId: randomUUID() } }) })
      .expect(400);

    const inactive = await makeMediaAsset({ isActive: false });
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, backgroundImageId: inactive } }) })
      .expect(400);

    // save a valid image, then deactivate it out from under the draft, and
    // confirm publish (which re-validates) also rejects it.
    const asset = await makeMediaAsset();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, backgroundImageId: asset } }) })
      .expect(200);
    await prisma.mediaAsset.update({ where: { id: asset }, data: { isActive: false } });
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(400);
  });

  it('rejects an unknown/inactive featured product id on save and on publish', async () => {
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ featuredProducts: { heading: 'x', productIds: [randomUUID()] } }) })
      .expect(400);

    const inactive = await makeProduct({ isActive: false });
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ featuredProducts: { heading: 'x', productIds: [inactive] } }) })
      .expect(400);

    const active = await makeProduct();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ featuredProducts: { heading: 'x', productIds: [active] } }) })
      .expect(200);
    await prisma.product.update({ where: { id: active }, data: { isActive: false } });
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(400);
  });

  // --- draft / publish lifecycle -----------------------------

  it('saves a draft, publishes, and keeps draft edits off the live snapshot until re-published', async () => {
    const product = await makeProduct();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({
        content: validHomeContent({
          hero: { ...validHomeContent().hero, headline: 'First' },
          featuredProducts: { heading: 'x', productIds: [product] },
        }),
      })
      .expect(200);
    let detail = (
      await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201)
    ).body as AdminCmsPageDetail;
    expect(detail.status).toBe('PUBLISHED');
    expect(detail.hasUnpublishedChanges).toBe(false);

    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, headline: 'Second' } }) })
      .expect(200);

    let publicBody = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(publicBody.content.hero.headline).toBe('First');

    detail = (
      await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201)
    ).body as AdminCmsPageDetail;
    expect(detail.hasUnpublishedChanges).toBe(false);

    publicBody = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(publicBody.content.hero.headline).toBe('Second');
  });

  it('audits Home draft-save and publish compactly — no content values', async () => {
    const before = await prisma.internalAuditEvent.count();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, headline: 'Secret Headline' } }) })
      .expect(200);
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201);

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'cms_page' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('Secret Headline');
    expect(await prisma.internalAuditEvent.count()).toBe(before + events.length);
  });

  // --- public resolution -------------------------------------

  it('resolves the published hero image to a URL; falls back to null when deactivated', async () => {
    const asset = await makeMediaAsset();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, backgroundImageId: asset } }) })
      .expect(200);
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201);

    let body = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(body.content.hero.backgroundImageUrl).toEqual(expect.stringContaining('media/'));

    // Deactivate directly (bypassing the 409 guard) to simulate a stale
    // reference and confirm the public page fails soft.
    await prisma.mediaAsset.update({ where: { id: asset }, data: { isActive: false } });
    body = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(body.content.hero.backgroundImageUrl).toBeNull();
  });

  it('resolves featured products preserving CMS order and dropping missing/inactive ones', async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const c = await makeProduct();
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({
        content: validHomeContent({
          featuredProducts: { heading: 'Favorites', productIds: [c, a, b] },
        }),
      })
      .expect(200);
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201);

    // deactivate `a` post-publish — public read must drop it, not error
    await prisma.product.update({ where: { id: a }, data: { isActive: false } });

    const body = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(body.content.featuredProducts.products.map((p) => p.id)).toEqual([c, b]);
  });

  it('renders an empty featured-products list cleanly (no 500)', async () => {
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent() })
      .expect(200);
    await adminReq('post', '/home/publish', `manager-${suffix}`).expect(201);
    const body = (await publicRead().expect(200)).body as PublicHomePageContentResponse;
    expect(body.content.featuredProducts.products).toEqual([]);
  });

  it('public read is 404 before any publish; never exposes draft content', async () => {
    await publicRead().expect(404);
    await adminReq('patch', '/home', `manager-${suffix}`)
      .send({ content: validHomeContent({ hero: { ...validHomeContent().hero, headline: 'Draft Only' } }) })
      .expect(200);
    await publicRead().expect(404);
  });
});
