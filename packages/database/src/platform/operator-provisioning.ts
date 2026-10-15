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
