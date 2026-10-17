import type { Metadata } from "next";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { OperatorPermissions } from "@/components/platform/OperatorPermissions";
import { listPlatformOperators } from "@/lib/platform/tenants-api";
import { getPlatformSession } from "@/lib/platform-auth/session";

export const metadata: Metadata = {
  title: "Operators · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const GRANTED_VIA: Record<string, string> = {
  CLI: "provisioning CLI",
  CLI_BOOTSTRAP: "initial bootstrap",
  CONSOLE: "console",
};

const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

// SC3e-3 (owner decision D7) — platform operators and their permissions
// (platform.permissions.manage). Changes are audited and never your own.
export default async function PlatformOperatorsPage() {
  const [result, session] = await Promise.all([listPlatformOperators(), getPlatformSession()]);
  const selfId = session.state === "signed-in" ? session.operator.id : null;
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader
        title="Operators"
        description="Who can do what in the console. Every grant and revocation is recorded with its reason; nobody changes their own."
      />
      {result.state !== "ok" ? (
        result.state === "access-denied" ? (
          <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
            Viewing and changing operator permissions needs platform.permissions.manage.
          </p>
        ) : (
          <RegistryStatePanel state={result.state} retryHref="/platform/operators" />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {result.data.operators.map((operator) => (
            <li key={operator.id} className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
              <p className="break-words font-semibold text-text-primary">
                {operator.displayName ? `${operator.displayName} · ` : ""}
                {operator.email}
                {operator.id === selfId ? " (you)" : ""}
                {operator.status !== "ACTIVE" ? ` · ${operator.status.toLowerCase()}` : ""}
              </p>
              {operator.permissions.length === 0 ? (
                <p className="text-text-secondary">No permissions (can read the console only).</p>
              ) : (
                <ul aria-label={`${operator.email}'s permissions`} className="flex flex-col gap-1">
                  {operator.permissions.map((grant) => (
                    <li key={grant.permission} className="break-words text-text-primary">
                      <span className="font-medium">{grant.permission}</span> — {date(grant.grantedAt)} via{" "}
                      {GRANTED_VIA[grant.grantedVia] ?? grant.grantedVia}
                      {grant.grantedBy ? ` by ${grant.grantedBy.email}` : ""}
                      {grant.reason ? `: ${grant.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <OperatorPermissions operator={operator} self={operator.id === selfId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
