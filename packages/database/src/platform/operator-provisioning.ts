import type { PrismaClient } from "../generated/prisma/client";
import { productionSignal } from "../runtime-environment";

// SC1a — the ONLY way a CENTERIVO platform operator is created or has its
// status changed: a deliberate, human-run CLI
// (prisma/scripts/platform-operator.ts). There is no API for it, no
// self-registration and no seed — nothing creates an operator automatically,
// in any environment.
//
// An operator is bound to a VERIFIED identity of the dedicated platform
// Cognito pool: (externalProvider, externalSubject), where the subject is
// the pool user's immutable `sub` (created in the pool first, by an admin).
// The email is informational. Every change is written together with a
// PlatformAuditEvent in one transaction.
//
// NOT exported from the package index: application code must never be able
// to provision an operator.

export type PlatformOperatorProvider = "cognito-platform" | "platform-dev";
export type PlatformOperatorStatusValue = "ACTIVE" | "DISABLED";

export const PLATFORM_OPERATOR_PROVIDERS: readonly PlatformOperatorProvider[] =
  ["cognito-platform", "platform-dev"];

export class OperatorProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorProvisioningError";
  }
}

export interface CreatePlatformOperatorInput {
  email: string;
  externalProvider: string;
  externalSubject: string;
  displayName?: string | null;
  // Required: provisioning always chooses the status explicitly.
  status: string;
}

type Env = Record<string, string | undefined>;

const DISPLAY_NAME_MAX_LENGTH = 200;
const SUBJECT_MAX_LENGTH = 200;

export function normalizeOperatorEmail(raw: string): string {
  const email = (raw ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) {
    throw new OperatorProvisioningError("A valid --email is required.");
  }
  return email;
}

function parseStatus(raw: string): PlatformOperatorStatusValue {
  if (raw !== "ACTIVE" && raw !== "DISABLED") {
    throw new OperatorProvisioningError(
      "--status must be exactly ACTIVE or DISABLED.",
    );
  }
  return raw;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function createPlatformOperator(
  prisma: PrismaClient,
  input: CreatePlatformOperatorInput,
  env: Env = process.env,
): Promise<{ id: string; email: string; status: PlatformOperatorStatusValue }> {
  const email = normalizeOperatorEmail(input.email);
  if (
    !PLATFORM_OPERATOR_PROVIDERS.includes(
      input.externalProvider as PlatformOperatorProvider,
    )
  ) {
    throw new OperatorProvisioningError(
      `--provider must be one of: ${PLATFORM_OPERATOR_PROVIDERS.join(", ")}.`,
    );
  }
  const provider = input.externalProvider as PlatformOperatorProvider;
  const signal = productionSignal(env);
  if (provider === "platform-dev" && signal !== null) {
    throw new OperatorProvisioningError(
      `A platform-dev operator cannot be created in a production-like environment (${signal}).`,
    );
  }
  const subject = (input.externalSubject ?? "").trim();
  if (subject.length === 0 || subject.length > SUBJECT_MAX_LENGTH) {
    throw new OperatorProvisioningError(
      "--subject (the pool user's sub) is required.",
    );
  }
  const displayName = input.displayName?.trim() || null;
  if (displayName && displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new OperatorProvisioningError("--display-name is too long.");
  }
  const status = parseStatus(input.status);

  try {
    return await prisma.$transaction(async (tx) => {
      const operator = await tx.platformOperator.create({
        data: {
          email,
          externalProvider: provider,
          externalSubject: subject,
          displayName,
          status,
        },
        select: { id: true, email: true, status: true },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: "platform.operator.created",
          outcome: "SUCCEEDED",
          reasonCode: "CLI",
          identityProvider: provider,
          identitySubject: subject,
        },
      });
      return operator;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OperatorProvisioningError(
        "An operator with that email or identity already exists.",
      );
    }
    throw error;
  }
}

// Idempotent: a status that is already in place changes nothing and writes
// no audit event.
export async function setPlatformOperatorStatus(
  prisma: PrismaClient,
  rawEmail: string,
  rawStatus: string,
): Promise<{ id: string; status: PlatformOperatorStatusValue; changed: boolean }> {
  const email = normalizeOperatorEmail(rawEmail);
  const status = parseStatus(rawStatus);
  return prisma.$transaction(async (tx) => {
    const operator = await tx.platformOperator.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        externalProvider: true,
        externalSubject: true,
      },
    });
    if (!operator) {
      throw new OperatorProvisioningError("No operator has that email.");
    }
    if (operator.status === status) {
      return { id: operator.id, status, changed: false };
    }
    await tx.platformOperator.update({
      where: { id: operator.id },
      data: { status },
    });
    await tx.platformAuditEvent.create({
      data: {
        action:
          status === "DISABLED"
            ? "platform.operator.disabled"
            : "platform.operator.enabled",
        outcome: "SUCCEEDED",
        reasonCode: "CLI",
        identityProvider: operator.externalProvider,
        identitySubject: operator.externalSubject,
      },
    });
    return { id: operator.id, status, changed: true };
  });
}

export async function listPlatformOperators(prisma: PrismaClient) {
  return prisma.platformOperator.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      displayName: true,
      externalProvider: true,
      status: true,
      lastAuthenticatedAt: true,
    },
  });
}

// The CLI must name the database it is about to change: the database name in
// DATABASE_URL has to equal --confirm-database, so a stale shell variable can
// never point a provisioning command at the wrong environment.
export function assertConfirmedDatabase(
  databaseUrl: string | undefined,
  confirmed: string | undefined,
): void {
  if (!databaseUrl) {
    throw new OperatorProvisioningError("DATABASE_URL is not set.");
  }
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new OperatorProvisioningError("DATABASE_URL could not be parsed.");
  }
  if (!name || !confirmed || confirmed !== name) {
    throw new OperatorProvisioningError(
      "--confirm-database must name the target database exactly.",
    );
  }
}

// --- SC3e-2: operator permissions (owner decision D1) ---------------------------
// Database-backed permissions, granted and revoked ONLY here (the CLI): no API
// can grant one, so an operator can never grant itself anything. Least
// privilege — one permission per kind of billing action; reads need none. A
// grant or revocation always has a reason and writes a PlatformAuditEvent in
// the same transaction. A revoked grant is kept (revokedAt): the history of
// who could do what is never lost.

export const PLATFORM_PERMISSIONS = [
  "billing.prices.manage",
  "billing.policy.manage",
  "billing.accounts.manage",
  "billing.reconciliation.run",
  "billing.cases.manage",
  "billing.schedules.release",
  "billing.complimentary.manage",
  // SC3e-3 — refunds and credits, and console permission grants.
  "billing.adjustments.request",
  "billing.adjustments.approve",
  "platform.permissions.manage",
  // SC3f — read-only SaaS revenue reporting (granted through this CLI).
  "billing.reports.view",
  // SC4e — onboarding oversight (read-only) and the registration pause.
  "onboarding.view",
  "onboarding.manage",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

// SC3e-3 (owner decision D7) — the permissions that move money or decide
// who may: never granted by the plain CLI. After the bootstrap they are
// granted only through the authenticated, audited console flow.
export const FINANCIAL_PERMISSIONS: readonly PlatformPermission[] = [
  "billing.adjustments.request",
  "billing.adjustments.approve",
  "platform.permissions.manage",
];

// The audit reason code of a permission (e.g. BILLING_COMPLIMENTARY_MANAGE).
export function permissionCode(permission: PlatformPermission): string {
  return permission.toUpperCase().replace(/\./g, "_");
}

function parsePermission(raw: string): PlatformPermission {
  if (!PLATFORM_PERMISSIONS.includes(raw as PlatformPermission)) {
    throw new OperatorProvisioningError(
      `--permission must be one of: ${PLATFORM_PERMISSIONS.join(", ")}.`,
    );
  }
  return raw as PlatformPermission;
}

function parseReason(raw: string | undefined): string {
  const reason = (raw ?? "").trim();
  if (
    reason.length < 10 ||
    reason.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(reason)
  ) {
    throw new OperatorProvisioningError(
      "--reason is required (10 to 500 characters, one line).",
    );
  }
  return reason;
}

// Idempotent: a permission the operator already holds changes nothing and
// writes no audit event. Only an ACTIVE operator can be granted one.
export async function grantPlatformPermission(
  prisma: PrismaClient,
  input: { email: string; permission: string; reason: string | undefined },
): Promise<{ operatorId: string; permission: PlatformPermission; changed: boolean }> {
  const email = normalizeOperatorEmail(input.email);
  const permission = parsePermission(input.permission);
  const reason = parseReason(input.reason);
  if (FINANCIAL_PERMISSIONS.includes(permission)) {
    throw new OperatorProvisioningError(
      `${permission} is never granted by the plain CLI: an operator holding platform.permissions.manage grants it in the Platform Console (or, before anyone does, use the documented bootstrap).`,
    );
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const operator = await tx.platformOperator.findUnique({
        where: { email },
        select: { id: true, status: true },
      });
      if (!operator) {
        throw new OperatorProvisioningError("No operator has that email.");
      }
      if (operator.status !== "ACTIVE") {
        throw new OperatorProvisioningError(
          "Only an ACTIVE operator can be granted a permission.",
        );
      }
      const live = await tx.platformOperatorPermission.findFirst({
        where: { operatorId: operator.id, permission, revokedAt: null },
        select: { id: true },
      });
      if (live) return { operatorId: operator.id, permission, changed: false };
      await tx.platformOperatorPermission.create({
        data: { operatorId: operator.id, permission, grantReason: reason },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: "platform.operator.permission_granted",
          outcome: "SUCCEEDED",
          reasonCode: permissionCode(permission),
          targetType: "platform_operator",
          targetId: operator.id,
        },
      });
      return { operatorId: operator.id, permission, changed: true };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OperatorProvisioningError(
        "That permission was granted concurrently; run permissions to check.",
      );
    }
    throw error;
  }
}

// SC3e-3 (owner decision D7) — the documented, restricted first grants of
// the financial permissions. Allowed ONLY while no ACTIVE operator holds
// platform.permissions.manage (once one does, every further grant goes
// through the authenticated console). Records who ran it (the OS account
// and host, accountable execution) and the reference of the independently
// recorded approval (e.g. the change ticket) — a reference, not a typed
// witness name. Audited.
export async function bootstrapFinancialPermission(
  prisma: PrismaClient,
  input: {
    email: string;
    permission: string;
    reason: string | undefined;
    approvalReference: string | undefined;
    executedBy: string;
  },
): Promise<{ operatorId: string; permission: PlatformPermission; changed: boolean }> {
  const email = normalizeOperatorEmail(input.email);
  const permission = parsePermission(input.permission);
  const reason = parseReason(input.reason);
  if (!FINANCIAL_PERMISSIONS.includes(permission)) {
    throw new OperatorProvisioningError(
      "The bootstrap is only for the financial permissions; use grant.",
    );
  }
  const approvalReference = (input.approvalReference ?? "").trim();
  if (approvalReference.length < 3 || approvalReference.length > 200) {
    throw new OperatorProvisioningError(
      "--approval-reference is required: the id of the independently recorded approval (3 to 200 characters).",
    );
  }
  const executedBy = input.executedBy.trim().slice(0, 200);
  if (!executedBy) {
    throw new OperatorProvisioningError("The executing account could not be determined.");
  }
  return prisma.$transaction(async (tx) => {
    // One time only: closed for good once platform.permissions.manage was
    // ever granted (even if later revoked, or its holder disabled), so it
    // can't be reopened by revoking or disabling the managers.
    const managers = await tx.platformOperatorPermission.count({
      where: { permission: "platform.permissions.manage" },
    });
    if (managers > 0) {
      throw new OperatorProvisioningError(
        "The bootstrap is closed: platform.permissions.manage has already been granted. Grant financial permissions in the Platform Console.",
      );
    }
    const operator = await tx.platformOperator.findUnique({
      where: { email },
      select: { id: true, status: true },
    });
    if (!operator) {
      throw new OperatorProvisioningError("No operator has that email.");
    }
    if (operator.status !== "ACTIVE") {
      throw new OperatorProvisioningError(
        "Only an ACTIVE operator can be granted a permission.",
      );
    }
    const live = await tx.platformOperatorPermission.findFirst({
      where: { operatorId: operator.id, permission, revokedAt: null },
      select: { id: true },
    });
    if (live) return { operatorId: operator.id, permission, changed: false };
    await tx.platformOperatorPermission.create({
      data: {
        operatorId: operator.id,
        permission,
        grantReason: reason,
        grantedVia: "CLI_BOOTSTRAP",
        approvalReference,
        executedBy,
      },
    });
    await tx.platformAuditEvent.create({
      data: {
        action: "platform.operator.permission_bootstrapped",
        outcome: "SUCCEEDED",
        reasonCode: permissionCode(permission),
        targetType: "platform_operator",
        targetId: operator.id,
      },
    });
    return { operatorId: operator.id, permission, changed: true };
    // Serializable: two concurrent bootstraps never both pass the check.
  }, { isolationLevel: "Serializable" });
}

// Idempotent: a permission the operator does not hold changes nothing.
export async function revokePlatformPermission(
  prisma: PrismaClient,
  input: { email: string; permission: string; reason: string | undefined },
): Promise<{ operatorId: string; permission: PlatformPermission; changed: boolean }> {
  const email = normalizeOperatorEmail(input.email);
  const permission = parsePermission(input.permission);
  const reason = parseReason(input.reason);
  return prisma.$transaction(async (tx) => {
    const operator = await tx.platformOperator.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!operator) {
      throw new OperatorProvisioningError("No operator has that email.");
    }
    const { count } = await tx.platformOperatorPermission.updateMany({
      where: { operatorId: operator.id, permission, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    if (count === 0) return { operatorId: operator.id, permission, changed: false };
    await tx.platformAuditEvent.create({
      data: {
        action: "platform.operator.permission_revoked",
        outcome: "SUCCEEDED",
        reasonCode: permissionCode(permission),
        targetType: "platform_operator",
        targetId: operator.id,
      },
    });
    return { operatorId: operator.id, permission, changed: true };
  });
}

// The live permissions of every operator (or one, by email).
export async function listPlatformPermissions(
  prisma: PrismaClient,
  rawEmail?: string,
) {
  const email = rawEmail ? normalizeOperatorEmail(rawEmail) : undefined;
  return prisma.platformOperatorPermission.findMany({
    where: { revokedAt: null, ...(email ? { operator: { email } } : {}) },
    orderBy: [{ operator: { email: "asc" } }, { permission: "asc" }],
    select: {
      permission: true,
      grantedAt: true,
      operator: { select: { id: true, email: true, status: true } },
    },
  });
}
