import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import type {
  PlatformTenantDetailResponse,
  PlatformTenantListResponse,
  PlatformTenantLocationListResponse,
  PlatformTenantSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isTenantId,
  type PlatformPaging,
  type PlatformTenantListQuery,
} from './platform-tenant-query';

// SC1c — the CENTERIVO tenant registry, read-only, for platform operators
// (PlatformAuthGuard admits the caller before any of this runs).
//
// What it reads, and only this:
//   - Tenant: the platform-plane registry record (id, slug, name, status,
//     suspension reason, timestamps);
//   - Location: name, slug and the two on/off flags, ALWAYS filtered by the
//     one business being viewed (tenantId) — never a cross-business list.
// It never selects a customer, order, payment, gift card, loyalty, staff or
// audit row, and it writes nothing (no tenant record or status changes).
//
// Not audited per read: these are business registry facts, not personal or
// financial data; refused access is already audited by PlatformAuthGuard.

const NOT_FOUND = 'Tenant not found.';

const TENANT_FIELDS = {
  id: true,
  slug: true,
  name: true,
  status: true,
  suspensionReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

@Injectable()
export class PlatformTenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PlatformTenantListQuery,
  ): Promise<PlatformTenantListResponse> {
    const where: Prisma.TenantWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { slug: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total, byStatus] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        // Oldest first: the first business on the platform leads the list.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          ...TENANT_FIELDS,
          _count: { select: { locations: true } },
        },
      }),
      this.prisma.tenant.count({ where }),
      this.prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const countOf = (status: 'ACTIVE' | 'SUSPENDED') =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const active = countOf('ACTIVE');
    const suspended = countOf('SUSPENDED');

    return {
      tenants: rows.map((row): PlatformTenantSummary => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        suspensionReason: row.suspensionReason,
        createdAt: row.createdAt.toISOString(),
        locationCount: row._count.locations,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      registry: { total: active + suspended, active, suspended },
    };
  }

  async detail(tenantId: string): Promise<PlatformTenantDetailResponse> {
    const tenant = await this.find(tenantId);
    const [total, active, digitalOrderingEnabled] = await Promise.all([
      this.prisma.location.count({ where: { tenantId: tenant.id } }),
      this.prisma.location.count({
        where: { tenantId: tenant.id, isActive: true },
      }),
      this.prisma.location.count({
        where: {
          tenantId: tenant.id,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      }),
    ]);
    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        suspensionReason: tenant.suspensionReason,
        createdAt: tenant.createdAt.toISOString(),
        updatedAt: tenant.updatedAt.toISOString(),
      },
      locations: { total, active, digitalOrderingEnabled },
    };
  }

  async locations(
    tenantId: string,
    paging: PlatformPaging,
  ): Promise<PlatformTenantLocationListResponse> {
    const tenant = await this.find(tenantId);
    const where: Prisma.LocationWhereInput = { tenantId: tenant.id };
    const [rows, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (paging.page - 1) * paging.pageSize,
        take: paging.pageSize,
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          isDigitalOrderingEnabled: true,
          createdAt: true,
        },
      }),
      this.prisma.location.count({ where }),
    ]);
    return {
      locations: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      page: paging.page,
      pageSize: paging.pageSize,
      total,
    };
  }

  // An unknown and a malformed id are the same 404.
  private async find(tenantId: string) {
    if (!isTenantId(tenantId)) throw new NotFoundException(NOT_FOUND);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: TENANT_FIELDS,
    });
    if (!tenant) throw new NotFoundException(NOT_FOUND);
    return tenant;
  }
}
