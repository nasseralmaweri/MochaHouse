import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getInternalSessionToken } from "@/lib/internal-auth/session";
import {
  ADMIN_BUSINESS_COOKIE,
  getAccessibleBusinesses,
} from "@/lib/internal-auth/active-business";
import { resolveActiveBusiness } from "@/lib/admin/business-context";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { BusinessChooser } from "./BusinessChooser";

export const metadata: Metadata = { title: "Choose a business · CENTERIVO" };

// Shown after sign-in when one person may enter several businesses and none
// is selected yet (Milestone S0F: the API answers 409 until a business is
// chosen). The list comes from the API, never from the client.
export default async function ChooseBusinessPage() {
  const token = await getInternalSessionToken();
  if (!token) {
    redirect("/internal/sign-in");
  }
  const accessible = await getAccessibleBusinesses(token);
  if (accessible.outcome !== "ok" || accessible.businesses.length === 0) {
    redirect("/internal/sign-in");
  }
  const cookieStore = await cookies();
  const resolution = resolveActiveBusiness(
    accessible.businesses,
    cookieStore.get(ADMIN_BUSINESS_COOKIE)?.value ?? null,
  );
  if (resolution.kind === "active") {
    redirect("/admin");
  }

  return (
    <div className="centerivo flex min-h-dvh flex-col items-center px-4 py-16">
      <CenterivoWordmark />
      <main className="mt-14 flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Choose a business
          </h1>
          <p className="text-[0.9375rem] text-text-secondary">
            Your account can work in more than one business. Pick where you want
            to start — you can switch at any time from the sidebar.
          </p>
        </div>
        <BusinessChooser businesses={accessible.businesses} />
      </main>
    </div>
  );
}
