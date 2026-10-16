import {
  OPTIONAL_MODULE_KEYS,
  isOptionalModuleKey,
  type OptionalModuleKey,
} from '@mocha-house/contracts';

// SC2a — plan and subscription request input, validated and normalised.
// Anything outside these rules is refused (400), never coerced.

export class PlanInputError extends Error {}

const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanInputError('A JSON body is required.');
  }
  return raw as Record<string, unknown>;
}

// Known optional modules, de-duplicated, in catalog order. "core" is never
// listed (it is always included).
export function parseModuleKeys(raw: unknown): OptionalModuleKey[] {
  if (!Array.isArray(raw) || raw.length > OPTIONAL_MODULE_KEYS.length * 2) {
    throw new PlanInputError('moduleKeys must be a list of modules.');
  }
  for (const key of raw) {
    if (!isOptionalModuleKey(key)) {
      throw new PlanInputError(
        `Unknown module: ${typeof key === 'string' ? key.slice(0, 40) : 'invalid'}.`,
      );
    }
  }
  const chosen = new Set(raw as OptionalModuleKey[]);
  return OPTIONAL_MODULE_KEYS.filter((key) => chosen.has(key));
}

export interface PlanCreateInput {
  key: string;
  name: string;
  description: string | null;
  moduleKeys: OptionalModuleKey[];
}

export function parsePlanCreate(raw: unknown): PlanCreateInput {
  const body = object(raw);
  const key = typeof body.key === 'string' ? body.key.trim().toLowerCase() : '';
  if (key.length < 2 || key.length > 50 || !KEY_PATTERN.test(key)) {
    throw new PlanInputError(
      'Plan key must be 2–50 lowercase letters or digits, in words joined by single hyphens.',
    );
  }
  const name =
    typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80 || hasControlCharacters(name)) {
    throw new PlanInputError('Plan name must be 2–80 characters.');
  }
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      throw new PlanInputError('Description must be text.');
    }
    const value = body.description.trim();
    if (value.length > 300 || hasControlCharacters(value.replace(/\n/g, ' '))) {
      throw new PlanInputError('Description must be at most 300 characters.');
    }
    description = value.length > 0 ? value : null;
  }
  return {
    key,
    name,
    description,
    moduleKeys: parseModuleKeys(body.moduleKeys),
  };
}

export function parseVersionModules(raw: unknown): OptionalModuleKey[] {
  return parseModuleKeys(object(raw).moduleKeys);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export type SubscriptionChange =
  | { kind: 'plan'; planVersionId: string }
  | { kind: 'grant'; moduleKey: OptionalModuleKey }
  | { kind: 'revoke'; moduleKey: OptionalModuleKey };

// Exactly one of planVersionId / grant / revoke.
export function parseSubscriptionChange(raw: unknown): SubscriptionChange {
  const body = object(raw);
  const given = ['planVersionId', 'grant', 'revoke'].filter(
    (field) => body[field] !== undefined && body[field] !== null,
  );
  if (given.length !== 1) {
    throw new PlanInputError(
      'Give exactly one of planVersionId, grant or revoke.',
    );
  }
  if (given[0] === 'planVersionId') {
    if (!isUuid(body.planVersionId)) {
      throw new PlanInputError('A valid planVersionId is required.');
    }
    return { kind: 'plan', planVersionId: body.planVersionId };
  }
  const moduleKey = body[given[0]];
  if (!isOptionalModuleKey(moduleKey)) {
    throw new PlanInputError('Unknown module.');
  }
  return given[0] === 'grant'
    ? { kind: 'grant', moduleKey }
    : { kind: 'revoke', moduleKey };
}
