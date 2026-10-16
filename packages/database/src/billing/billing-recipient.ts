import type { PrismaClient, Prisma } from "../generated/prisma/client";

// SC3c-3 — who CENTERIVO billing email for a business goes to, decided at
// the moment it is needed (the operator's view, and again by the worker at
// delivery time). Shared by the API and the worker so both apply the SAME
// rule:
//
//   1. the business's designated billing contact, if eligible now;
//   2. otherwise the earliest-created eligible administrator (holder of the
//      built-in platform-administrator role business-wide);
//   3. otherwise nobody — nothing is sent (the caller opens a
//      BILLING_CONTACT_MISSING case).
//
// Eligible = ACTIVE staff of THIS business, holding billing.manage at
// corporate scope (business-wide), whose stored email the identity provider
// asserted as VERIFIED within BILLING_EMAIL_VERIFICATION_MAX_AGE_DAYS. A
// sign-in long ago is not treated as permanent proof, and a verification of
// a different address (the stored email changed since) does not count.
// Every query is filtered by the business's id: staff of another business
// are never considered.

export const BILLING_MANAGE_PERMISSION = "billing.manage";
export const BILLING_ADMINISTRATOR_ROLE_KEY = "platform-administrator";
export const BILLING_EMAIL_VERIFICATION_MAX_AGE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BillingRecipientIneligibilityValue =
  | "NOT_ACTIVE"
  | "NO_BILLING_MANAGE"
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_VERIFICATION_STALE";

export interface BillingStaffMember {
  internalUserId: string;
  email: string;
  displayName: string | null;
  ineligibleReason: BillingRecipientIneligibilityValue | null;
}

export interface BillingRecipientResolution {
  designated: BillingStaffMember | null;
  recipient: (BillingStaffMember & {
    source: "CONTACT" | "FALLBACK_ADMINISTRATOR";
  }) | null;
  // ACTIVE staff holding billing.manage business-wide (may be designated).
  candidates: BillingStaffMember[];
}

type Db = Pick<PrismaClient, "internalUser" | "tenantBillingContact">;

const STAFF_SELECT = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  verifiedEmail: true,
  emailVerifiedAt: true,
  createdAt: true,
  roleAssignments: {
    where: { scopeType: "CORPORATE", scopeId: null },
    select: {
      role: {
        select: {
          key: true,
          permissions: {
            where: { permissionKey: BILLING_MANAGE_PERMISSION },
            select: { permissionKey: true },
          },
        },
      },
    },
  },
} as const satisfies Prisma.InternalUserSelect;

type StaffRow = Prisma.InternalUserGetPayload<{ select: typeof STAFF_SELECT }>;

function holdsBillingManage(row: StaffRow): boolean {
  return row.roleAssignments.some(
    (assignment) => assignment.role.permissions.length > 0,
  );
}

function isAdministrator(row: StaffRow): boolean {
  return row.roleAssignments.some(
    (assignment) => assignment.role.key === BILLING_ADMINISTRATOR_ROLE_KEY,
  );
}

export function billingRecipientIneligibility(
  row: {
    status: string;
    email: string;
    verifiedEmail: string | null;
    emailVerifiedAt: Date | null;
  },
  holdsManage: boolean,
  now: Date,
  maxAgeDays: number = BILLING_EMAIL_VERIFICATION_MAX_AGE_DAYS,
): BillingRecipientIneligibilityValue | null {
  if (row.status !== "ACTIVE") return "NOT_ACTIVE";
  if (!holdsManage) return "NO_BILLING_MANAGE";
  if (
    row.verifiedEmail === null ||
    row.emailVerifiedAt === null ||
    row.verifiedEmail !== row.email.trim().toLowerCase()
  ) {
    return "EMAIL_NOT_VERIFIED";
  }
  if (
    row.emailVerifiedAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
    now.getTime() - row.emailVerifiedAt.getTime() > maxAgeDays * DAY_MS
  ) {
    return "EMAIL_VERIFICATION_STALE";
  }
  return null;
}

function member(row: StaffRow, now: Date, maxAgeDays: number): BillingStaffMember {
  return {
    internalUserId: row.id,
    email: row.email,
    displayName: row.displayName,
    ineligibleReason: billingRecipientIneligibility(
      row,
      holdsBillingManage(row),
      now,
      maxAgeDays,
    ),
  };
}

export async function resolveBillingRecipient(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
  maxAgeDays: number = BILLING_EMAIL_VERIFICATION_MAX_AGE_DAYS,
): Promise<BillingRecipientResolution> {
  const contact = await db.tenantBillingContact.findUnique({
    where: { tenantId },
    select: { internalUserId: true },
  });
  const designatedRow =
    contact === null
      ? null
      : await db.internalUser.findFirst({
          where: { tenantId, id: contact.internalUserId },
          select: STAFF_SELECT,
        });
  const designated = designatedRow ? member(designatedRow, now, maxAgeDays) : null;

  // ACTIVE staff of THIS business with a business-wide grant of a role
  // holding billing.manage; earliest first (deterministic).
  const staff = await db.internalUser.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      roleAssignments: {
        some: {
          tenantId,
          scopeType: "CORPORATE",
          scopeId: null,
          role: {
            tenantId,
            permissions: { some: { permissionKey: BILLING_MANAGE_PERMISSION } },
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: STAFF_SELECT,
  });
  const candidates = staff.map((row) => member(row, now, maxAgeDays));

  let recipient: BillingRecipientResolution["recipient"] = null;
  if (designated !== null && designated.ineligibleReason === null) {
    recipient = { ...designated, source: "CONTACT" };
  } else {
    const fallback = staff.find(
      (row) =>
        isAdministrator(row) &&
        billingRecipientIneligibility(row, holdsBillingManage(row), now, maxAgeDays) ===
          null,
    );
    if (fallback) {
      recipient = {
        ...member(fallback, now, maxAgeDays),
        source: "FALLBACK_ADMINISTRATOR",
      };
    }
  }
  return { designated, recipient, candidates };
}
