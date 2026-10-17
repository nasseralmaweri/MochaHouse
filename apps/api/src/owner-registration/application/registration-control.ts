import { Logger } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  SELF_SERVICE_REGISTRATION_DAILY_LIMIT_ENV,
  SELF_SERVICE_REGISTRATION_ENV,
  ownerRegistrationConfig,
} from './owner-registration.config';

// SC4e — the facts registration decides on, shared by the registration
// routes (the authority) and the Platform Console (a read-only view of the
// same facts, never a second counter):
//
//   * the platform's emergency PAUSE of new registrations — the latest
//     RegistrationControlChange row. It can only stop registration: the
//     deployment flag SELF_SERVICE_REGISTRATION_ENABLED stays the master
//     control, and while it is off nothing here can turn registration on.
//   * the daily quota — new registrations (OwnerRegistration rows) created
//     in the rolling 24 hours, the exact count the start route enforces.

type Db = Prisma.TransactionClient | PrismaService;

export const REGISTRATION_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
// The transaction-scoped advisory lock between pausing / resuming
// (exclusive) and admitting a new code (shared): a code is admitted either
// before a pause commits or not at all.
export const REGISTRATION_CONTROL_LOCK = 4_401_000_001n;
const DEFAULT_DAILY_LIMIT = 50;

const logger = new Logger('RegistrationControl');

export async function latestRegistrationControl(db: Db) {
  return db.registrationControlChange.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      paused: true,
      reason: true,
      createdAt: true,
      actorPlatformOperator: { select: { email: true } },
    },
  });
}

// Whether new registrations are paused. Fails CLOSED: if the pause state
// cannot be read, new registration starts are treated as paused.
export async function isRegistrationPaused(db: Db): Promise<boolean> {
  try {
    return (await latestRegistrationControl(db))?.paused ?? false;
  } catch (error) {
    logger.error(
      `Registration pause state unreadable; refusing new registrations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

// The rolling 24-hour quota window as the start route counts it: how many
// registrations were created in it, and when the oldest of them leaves it.
export async function registrationQuotaWindow(
  db: Db,
  now: Date = new Date(),
): Promise<{ used: number; oldestAt: Date | null }> {
  const where = {
    createdAt: { gte: new Date(now.getTime() - REGISTRATION_QUOTA_WINDOW_MS) },
  };
  const [used, oldest] = await Promise.all([
    db.ownerRegistration.count({ where }),
    db.ownerRegistration.findFirst({
      where,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return { used, oldestAt: oldest?.createdAt ?? null };
}

export type RegistrationFlagState = 'ON' | 'OFF' | 'MISCONFIGURED';

// The deployment flag as configured: ON only when registration is enabled
// AND fully configured; a flag that is on with a missing or malformed
// setting is MISCONFIGURED (and registration is off).
export function registrationFlagState(
  env: Record<string, string | undefined> = process.env,
): RegistrationFlagState {
  if (ownerRegistrationConfig(env)) return 'ON';
  const flag = (env[SELF_SERVICE_REGISTRATION_ENV] ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' ? 'MISCONFIGURED' : 'OFF';
}

// The configured daily limit (the same parsing as the registration config),
// or null when it is malformed.
export function configuredDailyLimit(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const config = ownerRegistrationConfig(env);
  if (config) return config.dailyLimit;
  const value = env[SELF_SERVICE_REGISTRATION_DAILY_LIMIT_ENV]?.trim() ?? '';
  if (value === '') return DEFAULT_DAILY_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000
    ? parsed
    : null;
}
