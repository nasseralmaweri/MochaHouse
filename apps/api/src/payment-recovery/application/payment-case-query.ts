import {
  PAYMENT_CASE_CATEGORIES,
  PAYMENT_CASE_NOTE_MAX_LENGTH,
  PAYMENT_CASE_REASON_MAX_LENGTH,
  PAYMENT_CASE_REASON_MIN_LENGTH,
  type PaymentCaseCategory,
  type PaymentCaseStatus,
} from '@mocha-house/contracts';

// ESP-03 PR 5 — input parsing for the payment case routes. Anything not
// recognised is refused (PaymentCaseInputError → 400), never ignored.

export class PaymentCaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentCaseInputError';
  }
}

export interface PaymentCaseQuery {
  tenantId?: string;
  status?: PaymentCaseStatus;
  category?: PaymentCaseCategory;
  from?: Date;
  to?: Date;
}

const STATUSES: readonly PaymentCaseStatus[] = [
  'OPEN',
  'IN_REVIEW',
  'RESOLVED',
];
const QUERY_KEYS = new Set(['tenantId', 'status', 'category', 'from', 'to']);
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function single(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new PaymentCaseInputError(`${name} must be given once.`);
  }
  return raw;
}

function day(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined) return undefined;
  if (!DATE.test(raw)) {
    throw new PaymentCaseInputError(`${name} must be a date (YYYY-MM-DD).`);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new PaymentCaseInputError(`${name} must be a real date.`);
  }
  return date;
}

export function parsePaymentCaseQuery(
  raw: Record<string, unknown>,
): PaymentCaseQuery {
  for (const key of Object.keys(raw ?? {})) {
    if (!QUERY_KEYS.has(key)) {
      throw new PaymentCaseInputError(`Unknown filter: ${key.slice(0, 40)}.`);
    }
  }
  const query: PaymentCaseQuery = {};
  const tenantId = single(raw?.tenantId, 'tenantId');
  if (tenantId !== undefined) {
    if (!TENANT_ID.test(tenantId)) {
      throw new PaymentCaseInputError('tenantId is not a business id.');
    }
    query.tenantId = tenantId;
  }
  const status = single(raw?.status, 'status');
  if (status !== undefined) {
    if (!STATUSES.includes(status as PaymentCaseStatus)) {
      throw new PaymentCaseInputError(
        `status must be one of: ${STATUSES.join(', ')}.`,
      );
    }
    query.status = status as PaymentCaseStatus;
  }
  const category = single(raw?.category, 'category');
  if (category !== undefined) {
    if (!PAYMENT_CASE_CATEGORIES.includes(category as PaymentCaseCategory)) {
      throw new PaymentCaseInputError(
        `category must be one of: ${PAYMENT_CASE_CATEGORIES.join(', ')}.`,
      );
    }
    query.category = category as PaymentCaseCategory;
  }
  query.from = day(single(raw?.from, 'from'), 'from');
  const to = day(single(raw?.to, 'to'), 'to');
  // `to` is inclusive: cases created on that day are included.
  query.to = to ? new Date(to.getTime() + DAY_MS) : undefined;
  if (query.from && query.to && query.from >= query.to) {
    throw new PaymentCaseInputError('from must not be after to.');
  }
  if (!query.from) delete query.from;
  if (!query.to) delete query.to;
  return query;
}

function objectBody(
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PaymentCaseInputError('The request body must be an object.');
  }
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) {
      throw new PaymentCaseInputError(`Unknown field: ${key.slice(0, 40)}.`);
    }
  }
  return body as Record<string, unknown>;
}

export function parseRecoverRequest(body: unknown): { reason: string } {
  const { reason } = objectBody(body, ['reason']);
  if (typeof reason !== 'string') {
    throw new PaymentCaseInputError('A reason is required.');
  }
  const trimmed = reason.trim();
  if (
    trimmed.length < PAYMENT_CASE_REASON_MIN_LENGTH ||
    trimmed.length > PAYMENT_CASE_REASON_MAX_LENGTH
  ) {
    throw new PaymentCaseInputError(
      `The reason must be ${PAYMENT_CASE_REASON_MIN_LENGTH}–${PAYMENT_CASE_REASON_MAX_LENGTH} characters.`,
    );
  }
  return { reason: trimmed };
}

export function parseNoteRequest(body: unknown): { body: string } {
  const { body: text } = objectBody(body, ['body']);
  if (typeof text !== 'string') {
    throw new PaymentCaseInputError('A note is required.');
  }
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > PAYMENT_CASE_NOTE_MAX_LENGTH) {
    throw new PaymentCaseInputError(
      `A note must be 1–${PAYMENT_CASE_NOTE_MAX_LENGTH} characters.`,
    );
  }
  return { body: trimmed };
}
