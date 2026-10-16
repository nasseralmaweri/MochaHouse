import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistrySkeleton } from "@/components/platform/TenantRegistry";

// SC2a — shown while plans load.
export default function PlatformPlansLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader title="Plans" />
      <RegistrySkeleton rows={4} />
    </div>
  );
}
