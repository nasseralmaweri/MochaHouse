import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistrySkeleton } from "@/components/platform/TenantRegistry";

// SC1c — shown while the tenant registry loads (no figures until real ones
// arrive).
export default function PlatformTenantsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader title="Tenants" />
      <RegistrySkeleton rows={6} />
    </div>
  );
}
