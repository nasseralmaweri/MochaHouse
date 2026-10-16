import { RegistrySkeleton } from "@/components/platform/TenantRegistry";

// SC1c — shown while one business's registry record loads.
export default function PlatformTenantLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div
        aria-hidden="true"
        className="h-8 w-64 animate-pulse rounded-lg bg-surface-subtle motion-reduce:animate-none"
      />
      <RegistrySkeleton rows={4} />
    </div>
  );
}
