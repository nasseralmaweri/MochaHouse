import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistrySkeleton } from "@/components/platform/TenantRegistry";

// SC3b — shown while billing cases load.
export default function PlatformBillingLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader title="Billing" />
      <RegistrySkeleton rows={4} />
    </div>
  );
}
