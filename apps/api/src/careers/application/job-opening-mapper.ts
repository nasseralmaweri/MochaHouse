import type {
  AdminJobOpening,
  PublicJobOpeningDetail,
  PublicJobOpeningSummary,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';

export type JobOpeningRow = Prisma.JobOpeningGetPayload<{
  include: { location: { select: { id: true; name: true; isActive: true } } };
}>;

export function toAdminJobOpening(row: JobOpeningRow): AdminJobOpening {
  return {
    id: row.id,
    title: row.title,
    employmentType: row.employmentType,
    location: row.location
      ? { id: row.location.id, name: row.location.name }
      : null,
    summary: row.summary,
    description: row.description,
    responsibilities: row.responsibilities,
    qualifications: row.qualifications,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// PUBLICLY VISIBLE = PUBLISHED and (no location OR the location is active).
export function isPubliclyVisible(row: JobOpeningRow): boolean {
  return (
    row.status === 'PUBLISHED' &&
    (row.location === null || row.location.isActive)
  );
}

function publicSummary(row: JobOpeningRow): PublicJobOpeningSummary {
  return {
    id: row.id,
    title: row.title,
    employmentType: row.employmentType,
    locationName: row.location ? row.location.name : null,
    summary: row.summary,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export function toPublicJobOpeningSummary(
  row: JobOpeningRow,
): PublicJobOpeningSummary {
  return publicSummary(row);
}

export function toPublicJobOpeningDetail(
  row: JobOpeningRow,
): PublicJobOpeningDetail {
  return {
    ...publicSummary(row),
    description: row.description,
    responsibilities: row.responsibilities,
    qualifications: row.qualifications,
  };
}
