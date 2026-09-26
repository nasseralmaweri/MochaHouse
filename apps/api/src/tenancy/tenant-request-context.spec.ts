import 'dotenv/config';
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  TenantConfigurationError,
  TenantContextError,
  getCurrentTenantContext,
  type TenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyModule } from './tenancy.module';
import { CurrentTenantContext } from './current-tenant-context.decorator';
import { TenantDatabase } from './tenant-database';
import { REQUEST_ID_HEADER } from './tenant-context.middleware';

// A service with no access to the request — proves the context reaches
// code below the controller through the async-scoped carrier.
@Injectable()
class ProbeService {
  currentContext(): TenantContext | undefined {
    return getCurrentTenantContext();
  }
}

@Controller('s0c-probe')
class ProbeController {
  constructor(private readonly probe: ProbeService) {}

  @Get()
  read(@CurrentTenantContext() context: TenantContext) {
    return { context, fromService: this.probe.currentContext() ?? null };
  }

  @Post()
  write(@CurrentTenantContext() context: TenantContext) {
    return { context };
  }
}

// Milestone S0C — the API's TenantContext: startup validation, per-request
// establishment, and immunity to client-supplied tenant identifiers.
describe('API TenantContext (integration)', () => {
  const originalTenantId = process.env.SINGLE_TENANT_ID;
  // One test-owned client for every module compiled here, so a module that
  // deliberately FAILS to start (and therefore can never be closed) does
  // not leave its own connection pool open.
  const sharedPrisma = new PrismaService();

  afterEach(() => {
    process.env.SINGLE_TENANT_ID = originalTenantId;
  });

  afterAll(async () => {
    await sharedPrisma.$disconnect();
  });

  async function compileWith(tenantId: string | undefined) {
    if (tenantId === undefined) {
      delete process.env.SINGLE_TENANT_ID;
    } else {
      process.env.SINGLE_TENANT_ID = tenantId;
    }
    return Test.createTestingModule({
      imports: [PrismaModule, TenancyModule],
      controllers: [ProbeController],
      providers: [ProbeService],
    })
      .overrideProvider(PrismaService)
      .useValue(sharedPrisma)
      .compile();
  }

  describe('startup validation', () => {
    it('fails to start when SINGLE_TENANT_ID is missing', async () => {
      await expect(compileWith(undefined)).rejects.toThrow(
        TenantConfigurationError,
      );
    });

    it('fails to start when SINGLE_TENANT_ID is malformed', async () => {
      await expect(compileWith('mocha-house')).rejects.toThrow(
        TenantConfigurationError,
      );
    });

    it('fails to start when SINGLE_TENANT_ID references no tenant', async () => {
      await expect(
        compileWith('01a0db02-f800-7000-8000-00000000dead'),
      ).rejects.toThrow(TenantConfigurationError);
    });

    it('starts with a valid Tenant #1', async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      await moduleRef.close();
    });
  });

  describe('per-request context', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;

    beforeAll(async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      // Tenant B genuinely exists for these tests, so "the spoofed id was
      // ignored" cannot be explained by it merely being unknown.
      await createTestTenantB(prisma);
    });

    afterAll(async () => {
      await removeTestTenantB(prisma);
      await app.close();
    });

    it('establishes the configured tenant for a request, visible to the controller and to services below it', async () => {
      const response = await request(app.getHttpServer())
        .get('/s0c-probe')
        .expect(200);
      const body = response.body as {
        context: TenantContext;
        fromService: TenantContext | null;
      };

      expect(body.context.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(body.context.principalType).toBe('anonymous');
      expect(body.fromService).toEqual(body.context);
    });

    it('generates a server-side request id per request and echoes it', async () => {
      const first = await request(app.getHttpServer())
        .get('/s0c-probe')
        .expect(200);
      const second = await request(app.getHttpServer())
        .get('/s0c-probe')
        .expect(200);

      const firstId = (first.body as { context: TenantContext }).context
        .requestId;
      const secondId = (second.body as { context: TenantContext }).context
        .requestId;
      expect(first.headers[REQUEST_ID_HEADER]).toBe(firstId);
      expect(firstId).not.toBe(secondId);
    });

    it('ignores a client-supplied request id', async () => {
      const response = await request(app.getHttpServer())
        .get('/s0c-probe')
        .set(REQUEST_ID_HEADER, 'client-chosen-id')
        .expect(200);
      expect(
        (response.body as { context: TenantContext }).context.requestId,
      ).not.toBe('client-chosen-id');
    });

    it('cannot be overridden by tenant ids in headers, the query string or the body', async () => {
      const response = await request(app.getHttpServer())
        .post(
          `/s0c-probe?tenantId=${TEST_TENANT_B_ID}&tenant=${TEST_TENANT_B_ID}`,
        )
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .set('x-tenant', TEST_TENANT_B_ID)
        .set('tenant-id', TEST_TENANT_B_ID)
        .send({ tenantId: TEST_TENANT_B_ID, tenant: { id: TEST_TENANT_B_ID } })
        .expect(201);

      expect(
        (response.body as { context: TenantContext }).context.tenantId,
      ).toBe(TENANT_1_MOCHA_HOUSE_ID);
    });

    it('leaves no tenant context behind once the request completes', async () => {
      await request(app.getHttpServer()).get('/s0c-probe').expect(200);
      expect(getCurrentTenantContext()).toBeUndefined();
    });
  });

  describe('fail-closed access paths', () => {
    it('CurrentTenantContext refuses to run a handler when no context was established', async () => {
      // No TenancyModule, so no middleware: the decorator must not invent one.
      const moduleRef = await Test.createTestingModule({
        controllers: [ProbeController],
        providers: [ProbeService],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        await request(app.getHttpServer()).get('/s0c-probe').expect(500);
      } finally {
        await app.close();
      }
    });

    it('TenantDatabase refuses access without a valid TenantContext', async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      try {
        const database = moduleRef.get(TenantDatabase);
        expect(() => database.forContext(undefined)).toThrow(
          TenantContextError,
        );
        expect(() =>
          database.forContext({
            tenantId: 'not-a-tenant',
            principalType: 'system',
            requestId: 'r',
          }),
        ).toThrow(TenantContextError);
        expect(
          database.forContext({
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            principalType: 'system',
            requestId: 'r',
          }),
        ).toBe(moduleRef.get(PrismaService));
      } finally {
        await moduleRef.close();
      }
    });
  });
});
