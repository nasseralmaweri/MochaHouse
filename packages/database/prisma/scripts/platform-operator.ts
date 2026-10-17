// SC1a — CENTERIVO platform-operator provisioning. Human-run only.
//
//   DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator \
//     create  --confirm-database <db> --email <e> --provider cognito-platform \
//             --subject <pool user sub> --status ACTIVE [--display-name <n>]
//   ... platform:operator disable --confirm-database <db> --email <e>
//   ... platform:operator enable  --confirm-database <db> --email <e>
//   ... platform:operator list    --confirm-database <db>
//   SC3e-2 — permissions (least privilege; reads need none):
//   ... platform:operator grant       --confirm-database <db> --email <e> \
//             --permission <billing.…> --reason "<why, 10+ characters>"
//   ... platform:operator revoke      --confirm-database <db> --email <e> \
//             --permission <billing.…> --reason "<why>"
//   ... platform:operator permissions --confirm-database <db> [--email <e>]
//
// The operator's user must already exist in the DEDICATED platform Cognito
// pool (created by an administrator, MFA required); --subject is that user's
// immutable `sub`. Every create/enable/disable writes a PlatformAuditEvent in
// the same transaction. The connection string is never printed.
//
// Exit codes: 0 = done, 1 = refused (bad input / not found / duplicate),
// 2 = could not run.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import {
  OperatorProvisioningError,
  assertConfirmedDatabase,
  createPlatformOperator,
  grantPlatformPermission,
  listPlatformOperators,
  listPlatformPermissions,
  revokePlatformPermission,
  setPlatformOperatorStatus,
} from "../../src/platform/operator-provisioning";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const commands = ["create", "disable", "enable", "list", "grant", "revoke", "permissions"];
  if (!commands.includes(command ?? "")) {
    console.error(`Usage: platform:operator <${commands.join("|")}> ...`);
    return 1;
  }
  try {
    assertConfirmedDatabase(
      process.env.DATABASE_URL,
      argValue("--confirm-database"),
    );
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    if (command === "list") {
      for (const operator of await listPlatformOperators(prisma)) {
        console.log(
          [
            operator.id,
            operator.email,
            operator.externalProvider,
            operator.status,
            operator.lastAuthenticatedAt?.toISOString() ?? "never",
          ].join("\t"),
        );
      }
      return 0;
    }
    if (command === "permissions") {
      for (const row of await listPlatformPermissions(prisma, argValue("--email"))) {
        console.log(
          [
            row.operator.email,
            row.operator.status,
            row.permission,
            row.grantedAt.toISOString(),
          ].join("\t"),
        );
      }
      return 0;
    }
    if (command === "grant" || command === "revoke") {
      const input = {
        email: argValue("--email") ?? "",
        permission: argValue("--permission") ?? "",
        reason: argValue("--reason"),
      };
      const result =
        command === "grant"
          ? await grantPlatformPermission(prisma, input)
          : await revokePlatformPermission(prisma, input);
      console.log(
        result.changed
          ? `${command === "grant" ? "Granted" : "Revoked"} ${result.permission} for operator ${result.operatorId}.`
          : `Operator ${result.operatorId} ${command === "grant" ? "already holds" : "does not hold"} ${result.permission}; nothing changed.`,
      );
      return 0;
    }
    if (command === "create") {
      const created = await createPlatformOperator(prisma, {
        email: argValue("--email") ?? "",
        externalProvider: argValue("--provider") ?? "",
        externalSubject: argValue("--subject") ?? "",
        displayName: argValue("--display-name") ?? null,
        status: argValue("--status") ?? "",
      });
      console.log(`Created operator ${created.id} (${created.email}, ${created.status}).`);
      return 0;
    }
    const result = await setPlatformOperatorStatus(
      prisma,
      argValue("--email") ?? "",
      command === "disable" ? "DISABLED" : "ACTIVE",
    );
    console.log(
      result.changed
        ? `Operator ${result.id} is now ${result.status}.`
        : `Operator ${result.id} was already ${result.status}; nothing changed.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof OperatorProvisioningError) {
      console.error(error.message);
      return 1;
    }
    console.error("Provisioning failed. Nothing was changed.");
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(2),
);
